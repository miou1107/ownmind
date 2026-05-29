import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

// This test only verifies the lock file's stale-handling behavior, not the scanner itself.
// Because acquireLock hard-codes the path to ~/.ownmind/cache/scanner.lock, we only verify
// spawning another node process to write the lock, then simulating stale (making it exit),
// and re-acquiring should succeed.

const LOCK_PATH = path.join(os.homedir(), '.ownmind', 'cache', 'scanner.lock');

describe('scanner lock', () => {
  beforeEach(async () => {
    try { await fs.unlink(LOCK_PATH); } catch { /* ignore */ }
  });

  afterEach(async () => {
    try { await fs.unlink(LOCK_PATH); } catch { /* ignore */ }
  });

  it('acquires lock when none exists and releases on success', async () => {
    const { acquireLock, releaseLock } = await import(
      `../hooks/ownmind-usage-scanner.js?cb=${Date.now()}`
    );

    const got = await acquireLock();
    assert.equal(got, true);
    const raw = await fs.readFile(LOCK_PATH, 'utf8');
    assert.equal(raw.trim(), String(process.pid));

    await releaseLock();
    await assert.rejects(() => fs.stat(LOCK_PATH));
  });

  it('returns false when another live PID owns the lock', async () => {
    const { acquireLock, releaseLock } = await import(
      `../hooks/ownmind-usage-scanner.js?cb=${Date.now()}`
    );

    // Create a genuinely running child process and write its PID into the lock
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
    await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });
    await fs.writeFile(LOCK_PATH, String(child.pid));

    try {
      const got = await acquireLock();
      assert.equal(got, false, '活 PID 擁有 lock → acquire 應失敗');
      // lock should not be overwritten
      const raw = await fs.readFile(LOCK_PATH, 'utf8');
      assert.equal(raw.trim(), String(child.pid));
    } finally {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
      await releaseLock();
    }
  });

  it('takes over stale lock (PID no longer alive)', async () => {
    const { acquireLock, releaseLock } = await import(
      `../hooks/ownmind-usage-scanner.js?cb=${Date.now()}`
    );

    // Find a PID that is "almost impossible to be alive" (an already-exited child)
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.once('exit', r));
    const deadPid = child.pid;
    // Confirm it is really dead
    assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });

    await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });
    await fs.writeFile(LOCK_PATH, String(deadPid));

    const got = await acquireLock();
    assert.equal(got, true, 'dead PID → 視為 stale → 接手');
    const raw = await fs.readFile(LOCK_PATH, 'utf8');
    assert.equal(raw.trim(), String(process.pid));

    await releaseLock();
  });

  it('takes over lock older than 6h even if PID is still alive somehow', async () => {
    const { acquireLock, releaseLock } = await import(
      `../hooks/ownmind-usage-scanner.js?cb=${Date.now()}`
    );

    // Write our own PID, but set mtime to 7 hours ago
    await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });
    await fs.writeFile(LOCK_PATH, String(process.pid));
    const ancient = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await fs.utimes(LOCK_PATH, ancient, ancient);

    const got = await acquireLock();
    assert.equal(got, true, 'lock mtime > 6h → 視為 stale → 接手');
    await releaseLock();
  });
});
