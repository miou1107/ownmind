/**
 * The reply check, end to end, across the two hooks that now carry it.
 *
 * Both hooks are run as programs, against a staged $HOME, because the failure this suite
 * exists to catch is not a wrong decision — the decision functions have their own unit tests —
 * but a decision nobody ever asks for. An earlier draft of this wiring named a constant the
 * hook does not have, inside a catch that swallowed the ReferenceError; it would have shipped
 * green and never run once.
 *
 * The four states a user can land in, from the plan:
 *
 *   verdict arrived, nothing violated  → silence
 *   verdict arrived, something violated → the finding, and the AI told to fix it
 *   verdict not ready yet              → silence, it lands next turn
 *   the judge could not run            → said plainly, with what repairs it
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { tempDir } from './helpers/temp-dir.js';
import { listVerdicts, writeVerdict } from '../hooks/lib/verdict-store.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STOP_HOOK = path.join(repoRoot, 'hooks', 'ownmind-reply-lint.js');
const PROMPT_HOOK = path.join(repoRoot, 'hooks', 'ownmind-prompt-inject.js');

const SESSION = 'async-check-test';

/**
 * A $HOME with rules cached, credentials pointing wherever the caller says, and a transcript.
 *
 * `apiUrl` is the lever every test here pulls: an unreachable port makes the detached judge
 * fail immediately and in a knowable way, which is what lets an end-to-end test finish in a
 * second instead of in a minute of real judging.
 */
function stageHome({
  assistantText = 'I read file A first, then file B.',
  selectors = [{ id: 795, always_check: true, tags: [] }],
  injectables = [],
  apiUrl = 'http://127.0.0.1:1',
  present = true,
} = {}) {
  const home = tempDir('om-async-check-');
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.mkdirSync(path.join(home, '.ownmind', 'state'), { recursive: true });
  if (present) {
    fs.writeFileSync(
      path.join(home, '.ownmind', 'cache', 'enforcement.json'),
      JSON.stringify({ selectors, guards: [], injectables }),
    );
  }
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      ownmind: { env: { OWNMIND_API_KEY: 'test-key', OWNMIND_API_URL: apiUrl } },
    },
  }));

  // Two lines: a tail read discards whatever came first, so a one-line transcript reads as
  // empty. Real transcripts always have the user's turn ahead of the assistant's.
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: assistantText }] } }),
    '',
  ].join('\n'));

  return { home, transcript };
}

function hookEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    // These assertions quote English; a translated machine must not turn them red.
    OWNMIND_LOCALE_FORCE: 'en',
    ...extra,
  };
}

function runStopHook({ home, transcript, env = {} }) {
  try {
    return {
      status: 0,
      stdout: execFileSync('node', [STOP_HOOK], {
        input: JSON.stringify({
          session_id: SESSION,
          transcript_path: transcript,
          hook_event_name: 'Stop',
          stop_hook_active: false,
        }),
        encoding: 'utf8',
        env: hookEnv(home, env),
        timeout: 60_000,
      }),
      stderr: '',
    };
  } catch (err) {
    return { status: err.status ?? -1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

function runPromptHook({ home, prompt = 'next question', env = {} }) {
  try {
    return {
      status: 0,
      stdout: execFileSync('node', [PROMPT_HOOK], {
        input: JSON.stringify({
          session_id: SESSION,
          prompt,
          hook_event_name: 'UserPromptSubmit',
        }),
        encoding: 'utf8',
        env: hookEnv(home, env),
        timeout: 30_000,
      }),
      stderr: '',
    };
  } catch (err) {
    return { status: err.status ?? -1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

const stateOf = (home) => path.join(home, '.ownmind', 'state');

/**
 * Wait for the detached judge to land its answer, or give up and say so.
 *
 * `pending` does not count: that is the marker the Stop hook writes before spawning, so
 * accepting it would let a judge that never ran pass as a judge that answered.
 */
async function waitForVerdict(home, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const done = listVerdicts(SESSION, stateOf(home)).find((v) => v.record.outcome !== 'pending');
    if (done) return done.record;
    await sleep(100);
  }
  return null;
}

function writeVerdictFile(home, record) {
  writeVerdict(SESSION, 'staged-turn', record, stateOf(home));
}

test('the Stop hook starts the judge and does not wait for it', async () => {
  // A server that accepts and then says nothing, so the child sits on its 15-second HTTP
  // timeout. If the hook were still synchronous it would sit there too, and this is the
  // property the whole redesign rests on.
  const server = net.createServer(() => { /* accept, answer nothing */ });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const { home, transcript } = stageHome({ apiUrl: `http://127.0.0.1:${port}` });

  const started = Date.now();
  const result = runStopHook({ home, transcript });
  const elapsed = Date.now() - started;

  server.close();
  assert.equal(result.status, 0);
  assert.ok(elapsed < 10_000, `the hook waited ${elapsed}ms on a judge it must not wait for`);
  // The marker is written by the hook itself, before the spawn — so it is there whether the
  // child got as far as answering or died on the way up. That is the whole point of it.
  assert.equal(listVerdicts(SESSION, stateOf(home)).length, 1,
    'the Stop hook started no judge, and left nothing saying it had not');
});

test('a conversation the user switched OwnMind off in starts no judge', () => {
  // The judge runs on the user's own Claude Code subscription. Starting one after they typed
  // /ownmind-off spends their quota on a check they have just said they do not want.
  const { home, transcript } = stageHome();
  fs.writeFileSync(path.join(home, '.ownmind', 'state', 'session-off.json'), JSON.stringify({
    session_id: SESSION, off_at: new Date().toISOString(), tick_count: 0,
  }));

  const result = runStopHook({ home, transcript });
  assert.equal(result.status, 0);
  assert.deepEqual(listVerdicts(SESSION, stateOf(home)), [],
    'a judge was started for a conversation with OwnMind switched off');
});

test('a judge that could not reach the server tells the user so on the next turn', async () => {
  // The end-to-end path, with the server side made to fail instantly: Stop hook → detached
  // judge → verdict file → next turn's hook → the user's screen and the assistant's context.
  const { home, transcript } = stageHome({ apiUrl: 'http://127.0.0.1:1' });

  const stop = runStopHook({ home, transcript });
  assert.equal(stop.status, 0);

  const verdict = await waitForVerdict(home);
  assert.ok(verdict, 'the detached judge never wrote a verdict');
  assert.equal(verdict.outcome, 'failed');

  const prompt = runPromptHook({ home });
  assert.equal(prompt.status, 0);
  const parsed = JSON.parse(prompt.stdout);
  assert.match(parsed.systemMessage, /could not check/);
  assert.match(parsed.systemMessage, /update script/, 'a failure with no repair is just bad news');
  assert.match(parsed.hookSpecificOutput.additionalContext, /reply check did not run/);

  // Delivered once. Left in place it would re-announce on every turn for the rest of the
  // session, which teaches the reader to skip it.
  assert.deepEqual(listVerdicts(SESSION, stateOf(home)), [], 'the verdict was read but not taken');
});

test('the same outage does not put a red line under every single turn', () => {
  // The notice used to pass through the throttle in the Stop hook. It moved to the prompt
  // hook and left the throttle behind — and a line under every reply for the length of an
  // outage is worse than the outage, because the rational response is switching this off.
  const { home } = stageHome();
  const failure = { outcome: 'failed', failure: 'timeout', reason: 'no answer', violations: [] };

  writeVerdict(SESSION, 'turn-1', failure, stateOf(home));
  const first = runPromptHook({ home });
  assert.match(JSON.parse(first.stdout).systemMessage, /not checked against your rules/);

  writeVerdict(SESSION, 'turn-2', failure, stateOf(home));
  const second = runPromptHook({ home });
  assert.equal(second.stdout.trim(), '',
    'the second turn of the same outage announced it again');
});

test('a violation reaches the user and the assistant in one emission', () => {
  const { home } = stageHome();
  writeVerdictFile(home, {
    outcome: 'violation',
    check_id: 4321,
    violations: [{
      ruleId: 795, ruleCode: 'IR-125', ruleTitle: 'Lead with the conclusion',
      evidence: 'I read file A first', fix: 'Open with the answer.',
    }],
  });

  const result = runPromptHook({ home });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.systemMessage, /Lead with the conclusion/);
  assert.match(parsed.systemMessage, /reminder, not a block/,
    'this path arrives after the user has read the reply; it cannot claim to have handled it');
  assert.match(parsed.systemMessage, /4321/, 'without the id the user cannot report a false alarm');
  assert.match(parsed.hookSpecificOutput.additionalContext, /Lead with the conclusion/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /I read file A first/);
});

test('a clean verdict says nothing at all', () => {
  const { home } = stageHome();
  writeVerdictFile(home, { outcome: 'clean', violations: [] });

  const result = runPromptHook({ home });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '', 'a checked, clean turn must stay byte-for-byte silent');
});

test('no verdict yet is silent too, and costs nothing', () => {
  const { home } = stageHome();
  const result = runPromptHook({ home });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});

test('a waiting verdict is delivered alongside the standards this prompt pulled in', () => {
  // Two independent things the same hook has to say. An early return around either one drops
  // the other, and the one that gets dropped silently is the verdict.
  const { home } = stageHome({
    injectables: [{
      id: 900, type: 'iron_rule', title: 'Deploys are asked about first',
      keywords: ['deploy'], content: 'Ask before deploying.',
    }],
  });
  writeVerdictFile(home, {
    outcome: 'violation',
    violations: [{ ruleId: 795, ruleTitle: 'Lead with the conclusion', evidence: 'x', fix: 'y' }],
  });

  const result = runPromptHook({ home, prompt: 'time to deploy this' });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.hookSpecificOutput.additionalContext, /Deploys are asked about first/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /Lead with the conclusion/);
  assert.match(parsed.systemMessage, /Lead with the conclusion/);
});

test('a machine that never synced still delivers a waiting verdict', () => {
  // The never-synced notice used to return early. A verdict from the turn before would have
  // been taken off disk by nobody and announced by nobody.
  const { home } = stageHome({ present: false });
  writeVerdictFile(home, { outcome: 'failed', failure: 'no-cli', reason: 'claude not found' });

  const result = runPromptHook({ home });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.hookSpecificOutput.additionalContext, /No rules cache on this machine/i);
  assert.match(parsed.systemMessage, /Claude Code/,
    'a missing CLI gets the repair that works, not the one that cannot');
});

test('a rejected key says sign in again, not "try later"', () => {
  // Waiting fixes an outage and never fixes a revoked key. Collapsing the two was the bug the
  // synchronous path had its own notice key for; the judge moved, the distinction must not
  // have been left behind.
  const { home } = stageHome();
  writeVerdictFile(home, {
    outcome: 'failed', failure: 'unauthorized', reason: 'http 401', violations: [],
  });

  const result = runPromptHook({ home });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.systemMessage, /sign in again/);
});
