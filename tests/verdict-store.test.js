/**
 * The handover between the turn that judges and the turn that reads the verdict.
 *
 * The judge takes 29–54 seconds on the user's own subscription — measured — so it runs
 * detached and its answer waits in a file. Writer and reader are separate processes with no
 * lock between them, which is why the write is a rename and the read is a take.
 *
 * The per-turn keying that stops one turn's verdict landing on another's has its own file,
 * tests/reply-check-turn-identity.test.js. What is here is the mechanics: atomicity, the
 * credential in the job file, and the failure modes a detached writer has to survive.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';
import {
  verdictPath, jobPath, writeVerdict, listVerdicts, readVerdict, removeVerdict, writeJob, takeJob,
  sweepStaleSessions,
} from '../hooks/lib/verdict-store.js';

const dir = () => tempDir('om-verdict-');

test('a verdict written by one process is read by another', () => {
  const d = dir();
  assert.equal(writeVerdict('s1', 't1', { outcome: 'violation', violations: [{ ruleId: 795 }] }, d), true);
  const [got] = listVerdicts('s1', d);
  assert.equal(got.record.outcome, 'violation');
  assert.equal(got.record.violations[0].ruleId, 795);
  assert.ok(got.record.written_at, 'stamped, so a stale verdict can be recognised as one');
  assert.equal(got.record.session_id, 's1', 'and self-describing, so it cannot be misattributed');
});

test('a delivered verdict is taken — a verdict is delivered once', () => {
  // Left in place it would be re-reported every turn, which teaches the reader to skip it.
  const d = dir();
  writeVerdict('s1', 't1', { outcome: 'violation', violations: [] }, d);
  assert.equal(listVerdicts('s1', d).length, 1);
  removeVerdict('s1', 't1', d);
  assert.deepEqual(listVerdicts('s1', d), []);
});

test('nothing waiting is an empty list, not an error', () => {
  // The ordinary case: the judge is usually still running while the user types.
  assert.deepEqual(listVerdicts('never-judged', dir()), []);
});

test('a half-written file is never read as a verdict', () => {
  // The writer is detached and can be mid-write when the next turn arrives. The rename is
  // what makes the reader see either the old state or the whole new one.
  const d = dir();
  const target = verdictPath('s1', 't1', d);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{"outcome":"viol');      // what a torn write looks like
  const [got] = listVerdicts('s1', d);
  assert.equal(got.record.outcome, 'failed',
    'unreadable is a turn that went unchecked, never a guess and never silence');
  assert.equal(got.record.failure, 'unreadable');
});

test('a temporary file mid-rename is not mistaken for a verdict', () => {
  const d = dir();
  writeVerdict('s1', 't1', { outcome: 'clean' }, d);
  fs.writeFileSync(`${verdictPath('s1', 't2', d)}.999.tmp`, '{"outcome":"clean"}');
  assert.equal(listVerdicts('s1', d).length, 1);
});

test('reading one turn tells gone apart from unreadable', () => {
  // The collector acts on the difference. Gone means somebody else took it — another window
  // on this session, or the housekeeping — and there is nothing to say. Unreadable means a
  // turn whose verdict cannot be recovered, which is a turn that went unchecked. Collapsing
  // them makes one of the two a lie whichever way it goes.
  const d = dir();
  assert.equal(readVerdict('s1', 'never-existed', d), undefined, 'gone must be distinguishable');

  const target = verdictPath('s1', 't1', d);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{"outcome":"viol');
  assert.equal(readVerdict('s1', 't1', d), null, 'unreadable is not gone');

  writeVerdict('s1', 't2', { outcome: 'clean' }, d);
  assert.equal(readVerdict('s1', 't2', d).outcome, 'clean');
});

test('a verdict is no more readable than the job beside it', () => {
  // It holds 160 characters of what the AI said, plus the judge's quotes from it. On a shared
  // machine the default 0644 hands the user's own work to everybody with an account.
  const d = dir();
  writeVerdict('s1', 't1', { outcome: 'clean', reply_excerpt: 'what the AI said' }, d);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(verdictPath('s1', 't1', d)).mode & 0o777, 0o600);
  }
});

test('a job carries credentials, so it does not outlive its use', () => {
  const d = dir();
  const file = writeJob('s1', 't1', { apiKey: 'k-secret', assistantText: 'hi' }, d);
  assert.equal(file, jobPath('s1', 't1', d));

  const mode = fs.statSync(file).mode & 0o777;
  if (process.platform !== 'win32') {
    assert.equal(mode, 0o600, 'nobody else on the machine needs to read the key');
  }

  const job = takeJob(file);
  assert.equal(job.apiKey, 'k-secret');
  assert.equal(fs.existsSync(file), false, 'gone once used');
  assert.equal(takeJob(file), null);
});

test('a state directory that cannot be written is a false, not a crash', () => {
  // The caller is a hook on the critical path of every reply. It gets to carry on without a
  // verdict; it does not get to take the turn down with it. A NUL in the path is the cheapest
  // way to make the write fail identically on every platform.
  assert.equal(writeVerdict('s1', 't1', { outcome: 'clean' }, path.join(dir(), 'x\0y')), false);
});

test('a session that ended long ago stops taking up room', () => {
  // Every session leaves at most one file behind — the last turn's, judged after the user
  // stopped typing. "At most one, forever" is still a leak.
  const d = dir();
  writeVerdict('old', 't1', { outcome: 'clean' }, d);
  writeVerdict('current', 't1', { outcome: 'clean' }, d);

  const long = 7 * 24 * 60 * 60 * 1000;
  assert.equal(sweepStaleSessions(d, { olderThanMs: long, now: () => Date.now() }), 0,
    'nothing here is old yet, and a sweep that deletes fresh state loses verdicts');

  // Age only the one, by moving the clock rather than the file: the fresh session must
  // survive a sweep that the stale one does not.
  fs.utimesSync(verdictPath('old', 't1', d), new Date(Date.now() - long - 1000), new Date(Date.now() - long - 1000));
  assert.equal(sweepStaleSessions(d, { olderThanMs: long }), 1);
  assert.deepEqual(listVerdicts('old', d), []);
  assert.equal(listVerdicts('current', d).length, 1);
});
