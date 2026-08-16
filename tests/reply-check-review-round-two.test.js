/**
 * The second review of the async reply check, and the four ways it could still lie.
 *
 * Every one of these was reachable in code that had a green suite and ten mutations watched to
 * fail. They share a shape with the first round: the fix was right and the surrounding states
 * were not enumerated.
 *
 *   the server's rule fetch fails → it answers 200 with no rules → judging an empty rule list
 *     returns "skipped" → skipped is silence. The turn was not checked and nothing said so.
 *   the server's account lookup fails → it answers `enabled:false` → the user is told THEY
 *     switched rule checking off, which is a false statement about their own settings
 *   the Stop hook announced "OwnMind checked the AI's reply against your rules" on a turn
 *     where it had only STARTED a judge, thirty to fifty seconds from an answer
 *   the reply and the prompts went to the server unredacted, because the redaction lived in
 *     the file that was deleted when the judge moved onto the user's machine
 *
 * Plus the throttle parking itself on a stale key, a deadline that could delete a verdict that
 * had just landed, and two identical short replies to two different questions counting as one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { runJudgeJob } from '../hooks/lib/run-local-judge.js';
import { collectVerdict } from '../hooks/lib/verdict-collect.js';
import { startLocalJudge } from '../hooks/lib/start-local-judge.js';
import { listVerdicts, writeVerdict, jobPath, sweepStaleSessions } from '../hooks/lib/verdict-store.js';
import { redact, toReason } from '../hooks/lib/redact.js';
import { _logPathForTests } from '../hooks/lib/check-failure-log.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
_logPathForTests(path.join(tempDir('om-round-two-log-'), 'check-failures.jsonl'));

const ORIGINAL_FORCE = process.env.OWNMIND_LOCALE_FORCE;
process.env.OWNMIND_LOCALE_FORCE = 'en';
process.on('exit', () => {
  if (ORIGINAL_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_FORCE;
});

const JOB = {
  sessionId: 's1', turnId: 't1', apiUrl: 'https://example.invalid', apiKey: 'k',
  assistantText: 'the tests are green', userPrompts: ['修一下'],
};

/** Collects what would have been written, with the judge rigged to complain if it is called. */
function harness(selection, { allowJudge = false } = {}) {
  const written = [];
  const posted = [];
  return {
    written,
    posted,
    deps: {
      write: (_s, turnId, record) => { written.push({ turnId, ...record }); return true; },
      judge: async () => {
        if (!allowJudge) throw new Error('the judge must not be launched for this answer');
        return { outcome: 'clean', violations: [], verdicts: [], latencyMs: 1 };
      },
      postImpl: async (url, _key, body) => {
        posted.push({ url, body });
        return url.endsWith('/check') ? selection : { ok: true, resolved: true };
      },
    },
  };
}

const one = (record) => ({
  sessionId: 's1',
  list: () => [{ turnId: 't1', record }],
  remove: () => {},
  reread: () => record,
  sweep: () => {},
  logFailure: () => {},
  speak: (key) => key !== null,
});

// ------------------------------------------------------- the server's two failures

test('a server that could not fetch the rules is a failure, not a quiet clean turn', async () => {
  // src/routes/compliance.js answers 200 {enabled:true, outcome:'failed', check_id} with NO
  // rules when its rule query throws — and it calls that the likeliest failure in production.
  // Judging an empty rule list returns 'skipped'; 'skipped' is silence.
  const h = harness({ enabled: true, outcome: 'failed', violations: [], check_id: 77 });
  await runJudgeJob(JOB, h.deps);
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].outcome, 'failed');
  assert.equal(h.written[0].failure, 'server-declined');
  assert.equal(h.written[0].check_id, 77);
});

test('a failed answer that DOES carry a rule list is still a failure', async () => {
  // Isolates the `outcome === 'failed'` branch. The case above happens to be caught by the
  // "no rule list" guard as well — measured by breaking each one — so on its own it does not
  // prove this branch runs. An answer carrying both a failure and an empty list does.
  const h = harness({ enabled: true, outcome: 'failed', violations: [], rules: [], check_id: 5 });
  await runJudgeJob(JOB, h.deps);
  assert.equal(h.written[0].outcome, 'failed');
  assert.equal(h.written[0].failure, 'server-declined');
});

test('a server that could not read the account is not "you switched checking off"', async () => {
  // The account lookup failing answers {enabled:false, outcome:'failed'}. Reading `enabled`
  // first told the user their own setting was off — a false fact about their settings, and
  // one they would go and try to fix.
  const h = harness({ enabled: false, outcome: 'failed', violations: [] });
  await runJudgeJob(JOB, h.deps);
  assert.equal(h.written[0].outcome, 'failed',
    'a database blip was reported to the user as their own configuration');
  assert.equal(h.written[0].failure, 'server-declined');
});

test('an account that really is switched off still says so', async () => {
  // The control. Without it, a fix that reported everything as a server failure would pass
  // the two tests above.
  const h = harness({ enabled: false, outcome: 'skipped', violations: [] });
  await runJudgeJob(JOB, h.deps);
  assert.equal(h.written[0].outcome, 'disabled');
});

test('a 200 carrying no rule list at all is a failure, not silence', async () => {
  // An answer this code does not understand must not become "checked, nothing wrong" by
  // falling through to a judge with nothing to judge.
  const h = harness({ enabled: true, outcome: 'something-new', violations: [] });
  await runJudgeJob(JOB, h.deps);
  assert.equal(h.written[0].outcome, 'failed');
  assert.equal(h.written[0].failure, 'server-declined');
});

test('and the user is told what a declined server means for them', async () => {
  const out = await collectVerdict(one({
    outcome: 'failed', failure: 'server-declined', reason: 'the server could not finish',
  }));
  assert.equal(out.action, 'notice');
  assert.match(out.banner, /nothing for you to do/i, 'a notice that asks nothing must say so');
  assert.doesNotMatch(out.banner, /could not reach/,
    'the server answered; pointing the reader at their own network is the wrong repair');
});

// ------------------------------------------------------------------- redaction

test('the reply and the prompts are redacted before they leave the machine', async () => {
  // The redaction lived in compliance-client.js, which was deleted when the judge moved onto
  // the user's own machine. The new sender was written from scratch and did not carry it, so
  // a reply quoting a config file went to the server verbatim.
  const h = harness({ enabled: true, outcome: 'pending', check_id: 1, rules: [] }, { allowJudge: true });
  await runJudgeJob({
    ...JOB,
    assistantText: 'Set api_key=sk-live-abc123 and then run it with Bearer tok-xyz789',
    userPrompts: ['my password: hunter2'],
  }, h.deps);

  const sent = h.posted.find((p) => p.url.endsWith('/check')).body;
  assert.doesNotMatch(sent.assistant_text, /sk-live-abc123/, 'a key left the machine verbatim');
  assert.doesNotMatch(sent.assistant_text, /tok-xyz789/);
  assert.doesNotMatch(sent.user_prompts[0], /hunter2/);
  assert.match(sent.assistant_text, /REDACTED/);
});

test('the redactor leaves ordinary prose alone', async () => {
  // The control: a redactor that blanked everything would pass the test above and destroy the
  // thing being judged.
  const prose = '我先看了 A 檔案，又看了 B 檔案，最後發現問題在第 42 行。';
  assert.equal(redact(prose), prose);
});

test('the quote the judge takes from the reply is redacted too', async () => {
  // The reply is redacted on the way to the server, but the judge reads the RAW reply on this
  // machine and quotes it back as evidence — and that quote is posted to the server when the
  // audit row is closed. Same text, second road, so it needs the same treatment: a reply with
  // `api_key=…` on the line a rule was broken on would otherwise send that line verbatim.
  const { judgeLocally } = await import('../hooks/lib/local-judge.js');
  const dir = tempDir('om-round-two-judge-');
  const bin = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  const answer = JSON.stringify({
    verdicts: [{
      ruleId: 795, violated: true,
      evidence: 'run it with api_key=sk-live-abc123',
      fix: 'do not paste api_key=sk-live-abc123 into the reply',
    }],
  });
  fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { process.stdout.write(${JSON.stringify(answer)}); });\n`);
  fs.chmodSync(bin, 0o755);

  const out = await judgeLocally({
    rules: [{ id: 795, title: 'no keys in replies', judgeText: 'x' }],
    assistantText: 'run it with api_key=sk-live-abc123',
    claudeBin: bin,
  });
  assert.equal(out.outcome, 'violation');
  assert.doesNotMatch(out.violations[0].evidence, /sk-live-abc123/, 'the quote carries the key');
  assert.doesNotMatch(out.violations[0].fix, /sk-live-abc123/);
  assert.doesNotMatch(JSON.stringify(out.verdicts), /sk-live-abc123/,
    'and the verdicts array is what gets posted back to the server');
});

test('a failure reason cannot write an unbounded surprise to disk', async () => {
  // These are kept for weeks in the local diagnosis log. A proxy answering HTML to a request
  // expecting JSON puts the first of that HTML into the parser's error message.
  const huge = toReason(`x${'y'.repeat(5000)} token=abc123`);
  assert.ok(huge.length <= 200);
  assert.doesNotMatch(toReason('failed with token=abc123'), /abc123/);
});

// ---------------------------------------------------------- the Stop hook's claim

test('the Stop hook never says a reply was checked, because it cannot know', async () => {
  // It returns {action:'none'} with no notice key in two cases: no rule bore on the turn, and
  // a judge was successfully STARTED. The recovery line it printed there —
  // "OwnMind checked the AI's reply against your rules" — is false on both.
  const source = fs.readFileSync(path.join(repoRoot, 'hooks', 'ownmind-reply-lint.js'), 'utf8');
  const [beforeMain] = source.split('async function main()');
  assert.ok(!beforeMain.includes("'lint.recovered'"),
    'the Stop hook still announces a check it only started');
});

// ------------------------------------------------------------------ the throttle

test('a turn that carried a violation still puts the throttle back to healthy', async () => {
  // Otherwise: turn A fails and is announced; turn B finds a violation, so the recovery is
  // skipped and the throttle stays parked on the failure key; turn C fails the same way and
  // reads as "no change, stay quiet". Turn C went unchecked and nobody was told.
  const asked = [];
  await collectVerdict({
    ...one({
      outcome: 'violation',
      violations: [{ ruleId: 1, ruleTitle: 'Lead with the conclusion', evidence: 'a', fix: 'b' }],
    }),
    speak: (key) => { asked.push(key); return key !== null; },
  });
  assert.ok(asked.includes(null),
    'the throttle was never told this turn was healthy, so it is still on the last failure');
});

// -------------------------------------------------------------- the deadline race

test('a verdict that landed just past the deadline is delivered, not deleted', async () => {
  // The listing and the decision are not one operation, and the judge writes by renaming onto
  // exactly the path being judged stale. Measured budget is 115s against a 180s deadline.
  const removed = [];
  const now = 10_000_000;
  const out = await collectVerdict({
    sessionId: 's1',
    now: () => now,
    list: () => [{ turnId: 't1', record: { outcome: 'pending', started_at: 0 } }],
    remove: (_s, t) => removed.push(t),
    // What a judge that finished a second late leaves behind.
    reread: () => ({
      outcome: 'violation',
      violations: [{ ruleId: 1, ruleTitle: 'Lead with the conclusion', evidence: 'a', fix: 'b' }],
    }),
    sweep: () => {},
    logFailure: () => {},
    speak: (key) => key !== null,
  });
  assert.match(out.banner, /Lead with the conclusion/, 'the finding was thrown away');
  assert.doesNotMatch(out.banner, /never heard back/);
});

// ------------------------------------------------------ two replies that look alike

test('the same words answering two different questions are two checks', async () => {
  // "好的。" twice inside the judge window is not one turn twice. Which rules apply is decided
  // from the prompts as well, so deduping on the reply alone left the second turn with no
  // judge, no marker, no deadline, and therefore nothing that could report it.
  const d = tempDir('om-round-two-dedupe-');
  const calls = [];
  const base = {
    sessionId: 's1', assistantText: 'Done.', apiUrl: 'http://x', apiKey: 'k',
    stateDirImpl: d, spawnImpl: (bin, argv) => { calls.push(argv); return { unref() {} }; },
  };
  startLocalJudge({ ...base, userPrompts: ['deploy it'] });
  startLocalJudge({ ...base, userPrompts: ['what did you change?'] });
  assert.equal(calls.length, 2, 'the second question went unjudged and unreported');

  // And the control: the same reply to the same question, which is one turn reaching the hook
  // twice, still starts one judge.
  const again = tempDir('om-round-two-dedupe2-');
  const repeat = [];
  const same = { ...base, stateDirImpl: again, spawnImpl: () => { repeat.push(1); return { unref() {} }; }, userPrompts: ['deploy it'] };
  startLocalJudge(same);
  startLocalJudge(same);
  assert.equal(repeat.length, 1, 'one reply judged twice spends the user\'s quota twice');
});

// ----------------------------------------------------------- the job file's key

test('a job file nobody collected does not keep the API key for ever', async () => {
  // takeJob is the only thing that deletes one, so a child killed before its first read — a
  // reboot, an out-of-memory kill — leaves a 0600 file holding the key. Per-session naming
  // made them overwrite each other; one file per turn makes them accumulate.
  const d = tempDir('om-round-two-jobs-');
  const { turnId } = startLocalJudge({
    sessionId: 'dead', assistantText: 'x', userPrompts: [], apiUrl: 'http://x', apiKey: 'k-secret',
    stateDirImpl: d, spawnImpl: () => ({ unref() {} }),
  });
  const job = jobPath('dead', turnId, d);
  assert.ok(fs.existsSync(job));

  const week = 7 * 24 * 60 * 60 * 1000;
  const old = new Date(Date.now() - week - 60_000);
  fs.utimesSync(job, old, old);
  fs.utimesSync(path.dirname(job), old, old);
  for (const f of fs.readdirSync(path.join(d, 'verdicts', 'dead'))) {
    fs.utimesSync(path.join(d, 'verdicts', 'dead', f), old, old);
  }

  sweepStaleSessions(d, { olderThanMs: week });
  assert.equal(fs.existsSync(job), false, 'the key is still on disk a week later');
});

test('the sweep leaves a live session alone, even between verdicts', async () => {
  // Its directory is empty for the moment right after a verdict is delivered. Treating empty
  // as stale removed and recreated the live session's directory on every single turn.
  const d = tempDir('om-round-two-live-');
  writeVerdict('live', 't1', { outcome: 'clean' }, d);
  fs.unlinkSync(path.join(d, 'verdicts', 'live', 't1.json'));
  sweepStaleSessions(d, { olderThanMs: 7 * 24 * 60 * 60 * 1000 });
  assert.ok(fs.existsSync(path.join(d, 'verdicts', 'live')),
    'the directory of a session that is still going was swept');
  assert.deepEqual(listVerdicts('live', d), []);
});

// ------------------------------------------------------------- the whole path once

test('the two hooks still run, end to end, after all of the above', () => {
  // Cheap insurance against any of these fixes breaking the wiring: the Stop hook must return
  // at once and leave a marker, and the prompt hook must take whatever is waiting.
  const home = tempDir('om-round-two-e2e-');
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.mkdirSync(path.join(home, '.ownmind', 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ownmind', 'cache', 'enforcement.json'), JSON.stringify({
    selectors: [{ id: 1, always_check: true, tags: [] }], guards: [], injectables: [],
  }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'k', OWNMIND_API_URL: 'http://127.0.0.1:1' } } },
  }));
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a reply' }] } }),
    '',
  ].join('\n'));

  const env = { ...process.env, HOME: home, USERPROFILE: home, OWNMIND_LOCALE_FORCE: 'en' };
  const started = Date.now();
  execFileSync('node', [path.join(repoRoot, 'hooks', 'ownmind-reply-lint.js')], {
    input: JSON.stringify({
      session_id: 'round-two', transcript_path: transcript,
      hook_event_name: 'Stop', stop_hook_active: false,
    }),
    encoding: 'utf8', env, timeout: 30_000,
  });
  assert.ok(Date.now() - started < 10_000, 'the Stop hook waited on the judge');
  assert.equal(listVerdicts('round-two', path.join(home, '.ownmind', 'state')).length, 1);
});
