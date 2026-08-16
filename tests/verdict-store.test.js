/**
 * The handover between the turn that judges and the turn that reads the verdict.
 *
 * The judge takes 29–54 seconds on the user's own subscription — measured — so it runs
 * detached and its answer waits in a file. Writer and reader are separate processes with no
 * lock between them, which is why the write is a rename and the read is a take.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';
import {
  verdictPath, jobPath, writeVerdict, takeVerdict, writeJob, takeJob,
} from '../hooks/lib/verdict-store.js';

const dir = () => tempDir('om-verdict-');

test('a verdict written by one process is read by another', () => {
  const d = dir();
  assert.equal(writeVerdict('s1', { outcome: 'violation', violations: [{ ruleId: 795 }] }, d), true);
  const got = takeVerdict('s1', d);
  assert.equal(got.outcome, 'violation');
  assert.equal(got.violations[0].ruleId, 795);
  assert.ok(got.written_at, 'stamped, so a stale verdict can be recognised as one');
});

test('reading it takes it — a verdict is delivered once', () => {
  // Left in place it would be re-reported every turn, which teaches the reader to skip it.
  const d = dir();
  writeVerdict('s1', { outcome: 'violation', violations: [] }, d);
  assert.ok(takeVerdict('s1', d));
  assert.equal(takeVerdict('s1', d), null);
});

test('nothing waiting is null, not an error', () => {
  // The ordinary case: the judge is usually still running while the user types.
  assert.equal(takeVerdict('never-judged', dir()), null);
});

test('a half-written file is never read', () => {
  // The writer is detached and can be mid-write when the next turn arrives. The rename is
  // what makes the reader see either the old state or the whole new one.
  const d = dir();
  const target = verdictPath('s1', d);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(target, '{"outcome":"viol');      // what a torn write looks like
  assert.equal(takeVerdict('s1', d), null, 'unreadable is nothing, never a guess');
  assert.equal(fs.existsSync(target), false,
    'and it is removed, or it fails again on every turn for the rest of the session');
});

test('a session id cannot steer the file out of the state directory', () => {
  const d = dir();
  const p = verdictPath('../../../etc/passwd', d);
  assert.equal(path.dirname(p), d);
  assert.match(path.basename(p), /^reply-verdict-unknown\.json$/);
});

test('a job carries credentials, so it does not outlive its use', () => {
  const d = dir();
  const file = writeJob('s1', { apiKey: 'k-secret', assistantText: 'hi' }, d);
  assert.equal(file, jobPath('s1', d));

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
  assert.equal(writeVerdict('s1', { outcome: 'clean' }, path.join(dir(), 'x\0y')), false);
});
