/**
 * The judge job, end to end, with only the network and the CLI stood in for.
 *
 * This runs with nobody watching: spawned detached, no stdout anyone reads, no exit code
 * anyone checks, finishing long after the turn it belongs to. So the property under test is
 * always the same one — **whatever happens, a verdict file says what happened**. A check that
 * did not run must never be indistinguishable from a reply with nothing wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runJudgeJob } from '../hooks/lib/run-local-judge.js';

const JOB = {
  sessionId: 's1',
  apiUrl: 'https://example.invalid',
  apiKey: 'k',
  assistantText: '我先看了 A 檔案，又看了 B 檔案。',
  userPrompts: ['修一下'],
};

const RULES = [{ id: 795, title: '先講結論', judgeText: '第一句就是結論。' }];

/** Collects what would have been written, and what would have been posted where. */
function harness({ selection, verdict, selectThrows, resolveThrows }) {
  const written = [];
  const posted = [];
  return {
    written,
    posted,
    deps: {
      write: (sid, rec) => { written.push({ sid, ...rec }); return true; },
      judge: async (args) => { posted.push({ judged: args.rules.map((r) => r.id) }); return verdict; },
      postImpl: async (url, _key, body) => {
        posted.push({ url, body });
        if (url.endsWith('/check')) {
          if (selectThrows) throw new Error(selectThrows);
          return selection;
        }
        if (resolveThrows) throw new Error(resolveThrows);
        return { ok: true, resolved: true };
      },
    },
  };
}

test('a violation reaches the verdict file and closes the audit row', async () => {
  const h = harness({
    selection: { enabled: true, outcome: 'pending', check_id: 77, rules: RULES },
    verdict: {
      outcome: 'violation',
      violations: [{ ruleId: 795, ruleTitle: '先講結論', evidence: '我先看了', fix: '改開頭' }],
      verdicts: [{ ruleId: 795, violated: true }],
      latencyMs: 31000,
    },
  });
  await runJudgeJob(JOB, h.deps);

  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].outcome, 'violation');
  assert.equal(h.written[0].check_id, 77);
  assert.equal(h.written[0].violations[0].ruleId, 795);

  const resolve = h.posted.find((p) => p.url?.endsWith('/resolve'));
  assert.ok(resolve, 'a row left pending is a check nobody can prove ran');
  assert.equal(resolve.body.check_id, 77);
  assert.equal(resolve.body.outcome, 'violation');
  assert.equal(resolve.body.latency_ms, 31000);
});

test('the rules the server chose are the rules the judge is given', async () => {
  const h = harness({
    selection: { enabled: true, outcome: 'pending', check_id: 1, rules: RULES },
    verdict: { outcome: 'clean', violations: [], verdicts: [], latencyMs: 100 },
  });
  await runJudgeJob(JOB, h.deps);
  assert.deepEqual(h.posted.find((p) => p.judged)?.judged, [795],
    'the client holds selectors and no rule text; these have to come from the server');
});

test('the verdict is written before the server is told', async () => {
  // Ordering, not decoration. This finishes long after the turn, so the network is the thing
  // most likely to be gone — the user still gets their answer.
  const order = [];
  const h = harness({
    selection: { enabled: true, outcome: 'pending', check_id: 5, rules: RULES },
    verdict: { outcome: 'clean', violations: [], verdicts: [], latencyMs: 1 },
  });
  const deps = {
    ...h.deps,
    write: (...a) => { order.push('write'); return h.deps.write(...a); },
    postImpl: async (url, k, b) => {
      if (url.endsWith('/resolve')) order.push('resolve');
      return h.deps.postImpl(url, k, b);
    },
  };
  await runJudgeJob(JOB, deps);
  assert.deepEqual(order, ['write', 'resolve']);
});

test('a server that cannot be reached still leaves a verdict saying so', async () => {
  const h = harness({ selectThrows: 'getaddrinfo ENOTFOUND' });
  await runJudgeJob(JOB, h.deps);
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].outcome, 'failed');
  assert.equal(h.written[0].failure, 'server-unreachable');
  assert.deepEqual(h.written[0].violations, []);
  assert.match(h.written[0].reason, /ENOTFOUND/, 'and says what happened, for the log');
});

test('a judge that failed is recorded as failed, never as clean', async () => {
  const h = harness({
    selection: { enabled: true, outcome: 'pending', check_id: 9, rules: RULES },
    verdict: {
      outcome: 'failed', failure: 'no-cli', reason: 'claude is not on this machine',
      violations: [], latencyMs: 3,
    },
  });
  await runJudgeJob(JOB, h.deps);
  assert.equal(h.written[0].outcome, 'failed');
  assert.equal(h.written[0].failure, 'no-cli');
  const resolve = h.posted.find((p) => p.url?.endsWith('/resolve'));
  assert.equal(resolve.body.outcome, 'failed', 'the audit row hears about it too');
});

test('a resolve that does not go through does not cost the user their verdict', async () => {
  const h = harness({
    selection: { enabled: true, outcome: 'pending', check_id: 9, rules: RULES },
    verdict: { outcome: 'violation', violations: [{ ruleId: 795 }], verdicts: [], latencyMs: 3 },
    resolveThrows: 'http 502',
  });
  await runJudgeJob(JOB, h.deps);
  assert.equal(h.written[0].outcome, 'violation', 'written before the post, and it stays');
});

test('an account with the check switched off is not judged at all', async () => {
  // No quota spent, and nothing written — there is no verdict to deliver about a check the
  // account does not want.
  const h = harness({ selection: { enabled: false, outcome: 'skipped' } });
  await runJudgeJob(JOB, h.deps);
  assert.equal(h.written.length, 0);
  assert.equal(h.posted.filter((p) => p.judged).length, 0);
});

test('a turn no rule applies to spends nothing', async () => {
  const h = harness({ selection: { enabled: true, outcome: 'skipped', check_id: 3, rules: [] } });
  await runJudgeJob(JOB, h.deps);
  assert.equal(h.posted.filter((p) => p.judged).length, 0,
    'launching the CLI to be told nothing applied costs ~30s of the user\'s own quota');
  assert.equal(h.written.length, 0);
});
