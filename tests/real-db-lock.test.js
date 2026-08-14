import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * v1.30.1 — the mutex that keeps `tests/helpers/real-db.js` to one database container.
 *
 * The lock was shipped in v1.26.174 with no coverage of its own, and an independent review then
 * found three ways it could hand the same lock to two holders or never hand it back. Those are
 * the cases here. They are exercised against the real module, in a temporary lock directory, by
 * driving `acquireDbLock`/`releaseDbLock` through the only door they have — `startRealDb` — with
 * `docker` replaced by a stub on PATH, so no container is ever started.
 *
 * A stub rather than real docker: the property under test is who holds the lock and when, and a
 * real postgres would make each case a five-second wait for something that proves nothing extra.
 */

/** A directory holding a fake `docker` that answers `info` and swallows everything else. */
function stubDockerBin(behaviour = 'ok') {
  const dir = tempDir('stub-docker-');
  const script = behaviour === 'run-fails'
    // `docker info` succeeds so startRealDb gets past its availability check, then `run` fails
    // the way an image-pull failure or a bound port does.
    ? '#!/bin/sh\ncase "$1" in info) exit 0;; run) echo "boom" >&2; exit 125;; *) exit 0;; esac\n'
    : '#!/bin/sh\nexit 0\n';
  fs.writeFileSync(path.join(dir, 'docker'), script, { mode: 0o755 });
  return dir;
}

/**
 * Run one snippet in its own node process with a private lock dir (via TMPDIR) and a stubbed
 * docker, and return its stdout. Separate processes because the lock is cross-process: two
 * calls inside one process would share the module's `heldToken` and prove nothing.
 */
function runInProcess({ tmpdir, dockerBin, code }) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmpdir, PATH: `${dockerBin}:${process.env.PATH}` },
  });
}

const LOCK_NAME = 'ownmind-test-db.lock';

test('a live holder past the stale window keeps its lock', async () => {
  const tmpdir = tempDir('lock-live-');
  const lockDir = path.join(tmpdir, LOCK_NAME);

  // A holder that is this very process — unambiguously alive — but stamped 11 minutes ago.
  // The first cut checked age before liveness, so it declared this gone and stole the lock:
  // two containers at once, which is the whole thing the lock prevents.
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    pid: process.pid, at: Date.now() - 11 * 60 * 1000, token: 'held-by-a-live-process',
  }));

  const dockerBin = stubDockerBin();
  const out = runInProcess({
    tmpdir,
    dockerBin,
    // A short timeout so the waiter reports rather than sitting for ten minutes.
    code: `
      const t = setTimeout(() => { console.log('STILL_WAITING'); process.exit(0); }, 3000);
      t.unref?.();
      const { startRealDb } = await import(${JSON.stringify(path.join(repoRoot, 'tests/helpers/real-db.js'))});
      await startRealDb();
      console.log('ACQUIRED');
      process.exit(0);
    `,
  });
  assert.equal(out.trim(), 'STILL_WAITING',
    'a live holder must keep its lock however long it has held it — age is not death');
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).token,
    'held-by-a-live-process', 'and its owner record must be untouched');
});

test('a dead holder is broken through, and the new holder owns the lock', async () => {
  const tmpdir = tempDir('lock-dead-');
  const lockDir = path.join(tmpdir, LOCK_NAME);

  // pid 1 exists everywhere, so it cannot stand in for a dead process. Spawn one and reap it:
  // its pid is then genuinely absent, which is what `process.kill(pid, 0)` must detect.
  const corpse = execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  const deadPid = Number(corpse.trim());
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: deadPid, at: Date.now(), token: 'held-by-a-corpse' }));

  const dockerBin = stubDockerBin();
  const out = runInProcess({
    tmpdir,
    dockerBin,
    code: `
      const t = setTimeout(() => { console.log('STILL_WAITING'); process.exit(0); }, 5000);
      t.unref?.();
      const { startRealDb } = await import(${JSON.stringify(path.join(repoRoot, 'tests/helpers/real-db.js'))});
      const db = await startRealDb();
      console.log(db ? 'ACQUIRED' : 'NO_DOCKER');
      process.exit(0);
    `,
  });
  // The stub makes the readiness probe succeed instantly, so the acquire completes.
  assert.equal(out.trim(), 'ACQUIRED',
    'a holder whose process is gone must not block the queue forever');
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).token,
    'held-by-a-corpse', 'the new holder must have written its own owner record');
});

test('a failure after acquiring releases the lock instead of stranding it', async () => {
  const tmpdir = tempDir('lock-throw-');
  const lockDir = path.join(tmpdir, LOCK_NAME);
  const dockerBin = stubDockerBin('run-fails');

  const out = runInProcess({
    tmpdir,
    dockerBin,
    code: `
      const { startRealDb } = await import(${JSON.stringify(path.join(repoRoot, 'tests/helpers/real-db.js'))});
      try { await startRealDb(); console.log('UNEXPECTED_SUCCESS'); }
      catch { console.log('THREW'); }
      process.exit(0);
    `,
  });
  assert.equal(out.trim(), 'THREW', 'the fixture must make container startup fail');
  assert.equal(fs.existsSync(lockDir), false,
    'a throw after the lock was taken must still release it — otherwise every other DB test '
    + 'file blocks until this process exits');
});

test('a stale-broken holder cannot delete the lock its successor now holds', async () => {
  const tmpdir = tempDir('lock-token-');
  const lockDir = path.join(tmpdir, LOCK_NAME);
  const dockerBin = stubDockerBin();

  // Acquire, then have somebody else replace the owner record — exactly the state left behind
  // when this holder was judged stale and broken through. Its own release must then be a no-op:
  // an unconditional delete here frees a lock another process is actively holding.
  const out = runInProcess({
    tmpdir,
    dockerBin,
    code: `
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { startRealDb } = await import(${JSON.stringify(path.join(repoRoot, 'tests/helpers/real-db.js'))});
      const db = await startRealDb();
      const owner = path.join(${JSON.stringify(lockDir)}, 'owner.json');
      fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'somebody-elses' }));
      db.stop();
      console.log(fs.existsSync(${JSON.stringify(lockDir)}) ? 'LOCK_INTACT' : 'LOCK_DESTROYED');
      process.exit(0);
    `,
  });
  assert.equal(out.trim(), 'LOCK_INTACT',
    'release must prove the lock is still its own before removing it');
});
