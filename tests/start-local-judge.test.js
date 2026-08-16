/**
 * Starting the judge without waiting for it.
 *
 * The last test is the one that matters: it spawns the real runner, for real, and checks that
 * the parent is free immediately while the child goes on to produce a verdict. Everything
 * above it is the argv and the failure handling.
 *
 * The marker written before the spawn — the thing that makes a judge which died on the way up
 * distinguishable from a reply with nothing wrong — is covered in
 * tests/reply-check-turn-identity.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { tempDir } from './helpers/temp-dir.js';
import { startLocalJudge } from '../hooks/lib/start-local-judge.js';
import { listVerdicts, verdictPath } from '../hooks/lib/verdict-store.js';

const BASE = {
  sessionId: 's1',
  assistantText: '我先看了 A 檔案。',
  apiUrl: 'https://example.invalid',
  apiKey: 'k',
};

test('it hands the runner a job file and detaches', () => {
  const dir = tempDir('om-start-judge-argv-');
  let spawned = null;
  const out = startLocalJudge({
    ...BASE,
    stateDirImpl: dir,
    spawnImpl: (bin, argv, opts) => {
      spawned = { bin, argv, opts };
      return { unref() {} };
    },
  });

  assert.equal(out.started, true);
  assert.equal(spawned.bin, process.execPath);
  assert.ok(fs.existsSync(spawned.argv[1]), 'the job goes by path, since stdio is ignored');
  assert.equal(JSON.parse(fs.readFileSync(spawned.argv[1], 'utf8')).turnId, out.turnId,
    'the child has to write its verdict against the same turn the parent marked');
  assert.equal(spawned.opts.detached, true);
  assert.equal(spawned.opts.stdio, 'ignore',
    'inheriting stdout keeps the hook open, and an open hook is one the harness waits on');
});

test('a job that cannot be written does not spawn anything', () => {
  let spawned = false;
  const out = startLocalJudge({
    ...BASE,
    // A NUL in the path fails the write identically on every platform.
    stateDirImpl: path.join(tempDir('om-start-judge-bad-'), 'x\0y'),
    spawnImpl: () => { spawned = true; return { unref() {} }; },
  });
  assert.equal(out.started, false);
  assert.equal(spawned, false, 'a runner with no job would sit there and do nothing');
});

test('a spawn that throws is a false, not a thrown hook', () => {
  // The caller runs on the critical path of every reply. A judge that could not start is a
  // turn that goes on without one.
  const out = startLocalJudge({
    ...BASE,
    stateDirImpl: tempDir('om-start-judge-throw-'),
    spawnImpl: () => { throw new Error('EAGAIN'); },
  });
  assert.equal(out.started, false);
  assert.match(out.reason, /EAGAIN/);
});

test('nothing to judge does not start a judge', () => {
  for (const missing of ['sessionId', 'assistantText', 'apiUrl', 'apiKey']) {
    const opts = { ...BASE, [missing]: '' };
    assert.equal(startLocalJudge({ ...opts, spawnImpl: () => { throw new Error('should not spawn'); } }).started,
      false, `missing ${missing} must not start anything`);
  }
});

test('the parent is free at once, and the child still finishes the job', async () => {
  // The property the whole design rests on, exercised with a real spawn of the real runner.
  // A stub runner stands in for the server and the CLI — what is under test is that the
  // caller returns immediately and the work completes anyway.
  const dir = tempDir('om-start-judge-');
  const runner = path.join(dir, 'fake-runner.mjs');
  fs.writeFileSync(runner, `
    import fs from 'node:fs';
    import path from 'node:path';
    const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    setTimeout(() => {
      const target = ${JSON.stringify(verdictPath('s1', 'TURN', dir))}.replace('TURN', job.turnId);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ outcome: 'violation', violations: [{ ruleId: 795 }] }));
    }, 700);
  `);

  const started = Date.now();
  const out = startLocalJudge({ ...BASE, stateDirImpl: dir, runnerPath: runner });
  const returnedAfter = Date.now() - started;

  assert.equal(out.started, true);
  assert.ok(returnedAfter < 400,
    `the hook must not wait on the judge; it returned after ${returnedAfter}ms`);
  assert.equal(listVerdicts('s1', dir)[0].record.outcome, 'pending',
    'and it really had not finished yet — what is on disk is the marker, not an answer');

  await sleep(1500);
  const [verdict] = listVerdicts('s1', dir);
  assert.equal(verdict.record.outcome, 'violation', 'the child carried on after its parent returned');
});
