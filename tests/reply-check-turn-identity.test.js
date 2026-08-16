/**
 * One verdict per judged turn, and no turn that quietly loses its verdict.
 *
 * Review of the async reply check found five ways a finding could disappear without anybody
 * being able to tell it had. All five come from the same root: the handover files were named
 * after the session and nothing else, and the session has many turns.
 *
 *   the verdict for turn N is overwritten by turn N+1's, and the violation is gone
 *   the job for turn N is overwritten before its judge reads it; that judge then reads the
 *     wrong turn's text, and turn N+1's judge reads nothing and says nothing
 *   a verdict that lands two turns late is announced as "your last reply", which is a
 *     different reply — so the correction is applied to the wrong thing, permanently offset
 *   a judge that was started and then died writes nothing, which is byte-identical to a
 *     judge that ran and found nothing wrong
 *   an account with checking switched off writes nothing either, and the off state was
 *     supposed to be the loudest state there is
 *
 * Everything here is measured against files on disk, because that is the entire interface
 * between the process that judges and the process that reports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';
import {
  makeTurnId, verdictPath, jobPath, writeVerdict, listVerdicts, removeVerdict,
  writeJob, takeJob, JUDGE_DEADLINE_MS,
} from '../hooks/lib/verdict-store.js';
import { collectVerdict } from '../hooks/lib/verdict-collect.js';
import { startLocalJudge } from '../hooks/lib/start-local-judge.js';
import { runJudgeJob } from '../hooks/lib/run-local-judge.js';
import { _logPathForTests } from '../hooks/lib/check-failure-log.js';

// Anything here that reaches a failure records it, and the default target is the developer's
// own ~/.ownmind/logs/check-failures.jsonl. Measured while writing this file: 30 fabricated
// lines went into the real one before the guard that watches for exactly this was widened.
_logPathForTests(path.join(tempDir('om-turn-id-log-'), 'check-failures.jsonl'));

const ORIGINAL_FORCE = process.env.OWNMIND_LOCALE_FORCE;
process.env.OWNMIND_LOCALE_FORCE = 'en';
process.on('exit', () => {
  if (ORIGINAL_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_FORCE;
});

const dir = () => tempDir('om-turn-id-');
/**
 * A throttle stand-in that speaks every state notice and never announces a recovery.
 *
 * `null` is the key for "the check is healthy", and the real throttle answers it with "only
 * if it was unhealthy before". Answering true unconditionally would put a recovery line under
 * turns that never had a failure, which is what the first version of these tests measured.
 */
const always = (key) => key !== null;

// ---------------------------------------------------------------- the store

test('two turns of one session each keep their own verdict', () => {
  // C1. Both were written to `reply-verdict-<session>.json`, so the second landed on the
  // first: a violation found on the earlier reply was deleted by the later reply being clean.
  const d = dir();
  writeVerdict('s1', 'turn-a', { outcome: 'violation', violations: [{ ruleId: 795 }] }, d);
  writeVerdict('s1', 'turn-b', { outcome: 'clean', violations: [] }, d);

  const all = listVerdicts('s1', d);
  assert.equal(all.length, 2, 'one turn overwrote the other');
  assert.deepEqual(all.map((v) => v.turnId).sort(), ['turn-a', 'turn-b']);
});

test('two turns of one session each keep their own job', () => {
  // C2, the same collision one file earlier. The loser is worse off than in C1: its judge
  // reads a job that is not there, writes nothing, and exits — no verdict, no complaint.
  const d = dir();
  const a = writeJob('s1', 'turn-a', { apiKey: 'k', assistantText: 'first' }, d);
  const b = writeJob('s1', 'turn-b', { apiKey: 'k', assistantText: 'second' }, d);
  assert.notEqual(a, b);
  assert.equal(takeJob(a).assistantText, 'first');
  assert.equal(takeJob(b).assistantText, 'second');
});

test('one session cannot read another session\'s verdicts', () => {
  const d = dir();
  writeVerdict('s1', 't1', { outcome: 'clean' }, d);
  writeVerdict('s2', 't1', { outcome: 'violation', violations: [{ ruleId: 1 }] }, d);
  assert.equal(listVerdicts('s1', d).length, 1);
  assert.equal(listVerdicts('s1', d)[0].record.outcome, 'clean');
});

test('a session id cannot steer either file out of the state directory', () => {
  const d = dir();
  for (const p of [verdictPath('../../etc', 'x', d), jobPath('../../etc', 'x', d)]) {
    assert.ok(path.resolve(p).startsWith(path.resolve(d)), `${p} escaped ${d}`);
  }
  // And the turn id, which is generated here but arrives from a job file on the other side.
  assert.ok(path.resolve(verdictPath('s1', '../../etc/passwd', d)).startsWith(path.resolve(d)));
});

test('a delivered verdict is removed, and only that one', () => {
  const d = dir();
  writeVerdict('s1', 't1', { outcome: 'clean' }, d);
  writeVerdict('s1', 't2', { outcome: 'clean' }, d);
  removeVerdict('s1', 't1', d);
  assert.deepEqual(listVerdicts('s1', d).map((v) => v.turnId), ['t2']);
});

test('an unreadable verdict file is still attributed to its session', () => {
  // It cannot be parsed, but it can be named — and a turn whose verdict is unreadable is a
  // turn that went unchecked. Losing that quietly is the whole family of bugs above.
  const d = dir();
  const target = verdictPath('s1', 't1', d);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{"outcome":"viol');
  const all = listVerdicts('s1', d);
  assert.equal(all.length, 1);
  assert.equal(all[0].record.outcome, 'failed');
});

test('two turn ids from the same session differ', () => {
  assert.notEqual(makeTurnId('a reply'), makeTurnId('a different reply'));
  assert.match(makeTurnId('x'), /^[A-Za-z0-9.-]+$/, 'it becomes a filename');
});

// ------------------------------------------------------------ what is said

const stagedVerdict = (record, turnId = 't1') => [{ turnId, record }];

test('a verdict that landed late says which reply it is about', async () => {
  // C3. "Your previous reply" is what it used to say, and the previous reply is the one the
  // assistant has just written — so the correction was applied to the wrong turn, and stayed
  // one turn out of step for as long as the judge ran slower than the user typed.
  const removed = [];
  const out = await collectVerdict({
    sessionId: 's1',
    list: () => stagedVerdict({
      outcome: 'violation',
      reply_excerpt: 'I read file A first, then file B.',
      violations: [{ ruleId: 795, ruleTitle: 'Lead with the conclusion', evidence: 'I read file A first', fix: 'Open with the answer.' }],
    }),
    remove: (_s, t) => removed.push(t),
    speak: always,
  });

  assert.equal(out.action, 'notice');
  assert.match(out.forAssistant, /I read file A first, then file B\./,
    'the assistant cannot correct a reply it cannot identify');
  assert.doesNotMatch(out.forAssistant, /previous reply/,
    'the reply it is about is not necessarily the previous one');
  assert.deepEqual(removed, ['t1'], 'delivered once');
});

test('every violation is counted, not only the first', async () => {
  // I3. The line named violations[0] and said "one of your rules", so a reply that broke
  // three rules reported one and the other two were never mentioned to anybody.
  const out = await collectVerdict({
    sessionId: 's1',
    list: () => stagedVerdict({
      outcome: 'violation',
      violations: [
        { ruleId: 1, ruleTitle: 'Lead with the conclusion', evidence: 'a', fix: 'b' },
        { ruleId: 2, ruleTitle: 'No jargon', evidence: 'c', fix: 'd' },
        { ruleId: 3, ruleTitle: 'Ask before deploying', evidence: 'e', fix: 'f' },
      ],
    }),
    remove: () => {},
    speak: always,
  });
  assert.match(out.banner, /3/, 'the user was told about one of three');
  for (const title of ['Lead with the conclusion', 'No jargon', 'Ask before deploying']) {
    assert.match(out.forAssistant, new RegExp(title), `${title} never reached the assistant`);
  }
});

test('the violation line does not promise the AI will comply', async () => {
  // I3, and the product's own rule: a mechanism that only reminds must say it only reminds.
  // This path cannot stop a reply — it arrives after the user has read it — so "it will
  // correct itself, nothing for you to do" was a promise nothing here can keep.
  const out = await collectVerdict({
    sessionId: 's1',
    list: () => stagedVerdict({
      outcome: 'violation',
      violations: [{ ruleId: 1, ruleTitle: 'Lead with the conclusion', evidence: 'a', fix: 'b' }],
    }),
    remove: () => {},
    speak: always,
  });
  assert.doesNotMatch(out.banner, /Nothing for you to do/,
    'this path cannot block anything, so it must not tell the user it is handled');
});

test('a judge that was never started is reported once its time is up', async () => {
  // C4. The Stop hook spawns and returns; if the child dies on the way up, nothing is ever
  // written and the next turn is silent — the same silence a clean reply produces.
  const removed = [];
  const now = 10_000_000;
  const out = await collectVerdict({
    sessionId: 's1',
    now: () => now,
    list: () => stagedVerdict({
      outcome: 'pending',
      started_at: now - JUDGE_DEADLINE_MS - 1,
      reply_excerpt: 'something the AI said',
    }),
    remove: (_s, t) => removed.push(t),
    speak: always,
  });
  assert.equal(out.action, 'notice');
  assert.match(out.banner, /not checked/i);
  assert.deepEqual(removed, ['t1'], 'a marker kept forever re-reports forever');
});

test('a judge still within its time is left alone and said nothing about', async () => {
  // The control for the case above, and the common one: the user types faster than the judge
  // answers. Reporting there would put a red line under most turns.
  const removed = [];
  const now = 10_000_000;
  const out = await collectVerdict({
    sessionId: 's1',
    now: () => now,
    list: () => stagedVerdict({ outcome: 'pending', started_at: now - 1_000 }),
    remove: (_s, t) => removed.push(t),
    speak: always,
  });
  assert.equal(out.action, 'none');
  assert.deepEqual(removed, [], 'the verdict is still coming; taking the marker loses it');
});

test('an account with checking switched off is told so', async () => {
  // C5. The judge returned without writing, so the state the product calls its loudest
  // became its quietest.
  const out = await collectVerdict({
    sessionId: 's1',
    list: () => stagedVerdict({ outcome: 'disabled' }),
    remove: () => {},
    speak: always,
  });
  assert.equal(out.action, 'notice');
  assert.match(out.banner, /switched off/i);
});

test('a turn no rule applied to is silent, and its marker is cleared', async () => {
  // Not a failure — most turns match nothing. But the marker has to go, or the deadline
  // above turns every ordinary turn into "the judge did not finish".
  const removed = [];
  const out = await collectVerdict({
    sessionId: 's1',
    list: () => stagedVerdict({ outcome: 'skipped' }),
    remove: (_s, t) => removed.push(t),
    speak: always,
  });
  assert.equal(out.action, 'none');
  assert.deepEqual(removed, ['t1']);
});

test('a missing Claude Code is not told to run the update script', async () => {
  // I2. The update script installs OwnMind; it cannot install the CLI the judge runs on. The
  // user was being given a repair that could not repair it, every tenth turn, forever.
  const out = await collectVerdict({
    sessionId: 's1',
    list: () => stagedVerdict({ outcome: 'failed', failure: 'no-cli', reason: 'claude is not on this machine' }),
    remove: () => {},
    speak: always,
  });
  assert.equal(out.action, 'notice');
  assert.match(out.banner, /Claude Code/);
  assert.doesNotMatch(out.banner, /update script/,
    'the repair named must be one that works');
});

test('a failure the user is not shown is still written down where it can be diagnosed', async () => {
  // I4. The local failure log exists precisely because the user's line carries no error
  // vocabulary; after the judge moved off the server nothing wrote to it any more.
  const logged = [];
  await collectVerdict({
    sessionId: 's1',
    list: () => stagedVerdict({ outcome: 'failed', failure: 'timeout', reason: 'no answer in 90000ms', check_id: 7 }),
    remove: () => {},
    speak: () => false,               // throttled off the screen — the log still gets it
    logFailure: (e) => logged.push(e),
  });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].failure, 'timeout');
  assert.equal(logged[0].checkId, 7);
});

test('a repeated failure is throttled, and its key names the state', async () => {
  // I1. The notice used to pass through decideNotice in the Stop hook. It moved to the prompt
  // hook and left the throttle behind, so an outage put a red line under every single turn —
  // and the rational response to that is switching the product off.
  const asked = [];
  const out = await collectVerdict({
    sessionId: 's1',
    list: () => stagedVerdict({ outcome: 'failed', failure: 'timeout' }),
    remove: () => {},
    speak: (key) => { asked.push(key); return false; },
  });
  assert.equal(asked.length, 1, 'the throttle was never consulted');
  assert.ok(asked[0], 'a state notice with no key can never be throttled');
  assert.equal(out.action, 'none', 'suppressed means not shown');
});

test('a violation is never throttled', async () => {
  // Event-shaped, not state-shaped: a rule broken on this turn is news every time.
  const asked = [];
  const out = await collectVerdict({
    sessionId: 's1',
    list: () => stagedVerdict({
      outcome: 'violation',
      violations: [{ ruleId: 1, ruleTitle: 'Lead with the conclusion', evidence: 'a', fix: 'b' }],
    }),
    remove: () => {},
    speak: (key) => { asked.push(key); return false; },
  });
  assert.equal(out.action, 'notice', 'a finding was suppressed as though it were a state');
});

// ------------------------------------------------- starting and running one

function fakeSpawn() {
  const calls = [];
  const impl = (bin, argv) => { calls.push({ bin, argv }); return { unref() {} }; };
  return { impl, calls };
}

test('the marker is on disk before the child is spawned', async () => {
  // C4's fix has to be written by the parent. A child that dies before its first line runs
  // is exactly the case being covered, so it cannot be the one to record that it started.
  const d = dir();
  const { impl, calls } = fakeSpawn();
  const started = startLocalJudge({
    sessionId: 's1',
    assistantText: 'a reply',
    apiUrl: 'http://x',
    apiKey: 'k',
    stateDirImpl: d,
    spawnImpl: impl,
  });

  assert.equal(started.started, true);
  assert.equal(calls.length, 1);
  const all = listVerdicts('s1', d);
  assert.equal(all.length, 1);
  assert.equal(all[0].record.outcome, 'pending');
  assert.ok(all[0].record.started_at, 'without a start time there is no deadline to miss');
  assert.match(all[0].record.reply_excerpt, /a reply/);
});

test('a spawn that fails leaves no marker to expire', async () => {
  // Otherwise the user is told twice: once by the hook, now, and once by the deadline three
  // minutes later — and the second one names a judge that was never started.
  const d = dir();
  const started = startLocalJudge({
    sessionId: 's1',
    assistantText: 'a reply',
    apiUrl: 'http://x',
    apiKey: 'k',
    stateDirImpl: d,
    spawnImpl: () => { throw new Error('ENOENT'); },
  });
  assert.equal(started.started, false);
  assert.deepEqual(listVerdicts('s1', d), []);
});

test('a second judge is not started for a reply already being judged', async () => {
  // The Stop hook runs ahead of the stop_hook_active return by design, so one reply can
  // reach it twice. Judging it twice spends the user's own subscription twice.
  const d = dir();
  const { impl, calls } = fakeSpawn();
  const args = {
    sessionId: 's1', assistantText: 'the same reply', apiUrl: 'http://x', apiKey: 'k',
    stateDirImpl: d, spawnImpl: impl,
  };
  startLocalJudge(args);
  const second = startLocalJudge(args);
  assert.equal(second.started, true, 'the turn is covered — by the judge already running');
  assert.equal(calls.length, 1, 'the user paid for the same reply twice');
});

test('an account with checking off resolves its marker instead of abandoning it', async () => {
  // C5 at the writer's end. Returning without writing left the marker to expire three
  // minutes later as "the judge did not finish", which is a different and untrue thing.
  const written = [];
  await runJudgeJob(
    { sessionId: 's1', turnId: 't1', assistantText: 'hi', apiUrl: 'http://x', apiKey: 'k' },
    {
      postImpl: async () => ({ enabled: false, outcome: 'skipped' }),
      judge: async () => { throw new Error('the judge must not be run for a disabled account'); },
      write: (_s, t, record) => written.push({ turnId: t, ...record }),
    },
  );
  assert.equal(written.length, 1);
  assert.equal(written[0].outcome, 'disabled');
  assert.equal(written[0].turnId, 't1');
});

test('a turn no rule applied to resolves its marker too', async () => {
  const written = [];
  await runJudgeJob(
    { sessionId: 's1', turnId: 't1', assistantText: 'hi', apiUrl: 'http://x', apiKey: 'k' },
    {
      postImpl: async () => ({ enabled: true, outcome: 'skipped', check_id: 3, rules: [] }),
      judge: async () => { throw new Error('nothing applied; the CLI must not be launched'); },
      write: (_s, t, record) => written.push({ turnId: t, ...record }),
    },
  );
  assert.equal(written.length, 1);
  assert.equal(written[0].outcome, 'skipped');
});

test('the verdict carries the reply it was about', async () => {
  const written = [];
  await runJudgeJob(
    {
      sessionId: 's1', turnId: 't1', apiUrl: 'http://x', apiKey: 'k',
      assistantText: 'I read file A first, then file B.',
    },
    {
      postImpl: async () => ({
        enabled: true, outcome: 'pending', check_id: 9,
        rules: [{ id: 795, title: 'Lead with the conclusion', judgeText: 'x' }],
      }),
      judge: async () => ({ outcome: 'clean', violations: [], latencyMs: 5 }),
      write: (_s, t, record) => written.push(record),
    },
  );
  assert.match(written[0].reply_excerpt, /I read file A first/);
});
