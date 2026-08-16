/**
 * Starting the judge without waiting for it.
 *
 * The last test is the one that matters: it spawns the real runner, for real, and checks that
 * the parent is free immediately while the child goes on to produce a verdict. Everything
 * above it is the argv and the failure handling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { tempDir } from './helpers/temp-dir.js';
import { startLocalJudge } from '../hooks/lib/start-local-judge.js';
import { verdictPath, takeVerdict } from '../hooks/lib/verdict-store.js';

const BASE = {
  sessionId: 's1',
  assistantText: '我先看了 A 檔案。',
  apiUrl: 'https://example.invalid',
  apiKey: 'k',
};

test('it hands the runner a job file and detaches', () => {
  let spawned = null;
  const out = startLocalJudge({
    ...BASE,
    writeJobImpl: () => '/tmp/job.json',
    spawnImpl: (bin, argv, opts) => {
      spawned = { bin, argv, opts };
      return { unref() {} };
    },
  });

  assert.equal(out.started, true);
  assert.equal(spawned.bin, process.execPath);
  assert.equal(spawned.argv[1], '/tmp/job.json', 'the job goes by path, since stdio is ignored');
  assert.equal(spawned.opts.detached, true);
  assert.equal(spawned.opts.stdio, 'ignore',
    'inheriting stdout keeps the hook open, and an open hook is one the harness waits on');
});

test('a job that cannot be written does not spawn anything', () => {
  let spawned = false;
  const out = startLocalJudge({
    ...BASE,
    writeJobImpl: () => null,
    spawnImpl: () => { spawned = true; return { unref() {} }; },
  });
  assert.equal(out.started, false);
  assert.equal(spawned, false, 'a runner with no job would sit there and do nothing');
  assert.match(out.reason, /could not be written/);
});

test('a spawn that throws is a false, not a thrown hook', () => {
  // The caller runs on the critical path of every reply. A judge that could not start is a
  // turn that goes on without one.
  const out = startLocalJudge({
    ...BASE,
    writeJobImpl: () => '/tmp/job.json',
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
    const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(verdictPath('s1', dir))},
        JSON.stringify({ outcome: 'violation', violations: [{ ruleId: job.turnIndex ?? 795 }] }));
    }, 700);
  `);

  const started = Date.now();
  const out = startLocalJudge({
    ...BASE,
    runnerPath: runner,
    writeJobImpl: (sid, job) => {
      const f = path.join(dir, 'job.json');
      fs.writeFileSync(f, JSON.stringify(job));
      return f;
    },
  });
  const returnedAfter = Date.now() - started;

  assert.equal(out.started, true);
  assert.ok(returnedAfter < 400,
    `the hook must not wait on the judge; it returned after ${returnedAfter}ms`);
  assert.equal(takeVerdict('s1', dir), null, 'and it really had not finished yet');

  await sleep(1500);
  const verdict = takeVerdict('s1', dir);
  assert.ok(verdict, 'the child carried on after its parent returned');
  assert.equal(verdict.outcome, 'violation');
});
