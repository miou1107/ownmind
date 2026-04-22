import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

// 這支 test 只驗證 lock file 的 stale-handling 行為，不跑 scanner 本身。
// 因為 acquireLock 硬編路徑為 ~/.ownmind/cache/scanner.lock，我們只驗證 spawn 另一
// 個 node process 寫 lock、然後模擬 stale（讓它退出）、重新 acquire 應成功。

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

    // 建一個真的在跑的 child process，寫其 PID 進 lock
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
    await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });
    await fs.writeFile(LOCK_PATH, String(child.pid));

    try {
      const got = await acquireLock();
      assert.equal(got, false, '活 PID 擁有 lock → acquire 應失敗');
      // lock 不該被覆寫
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

    // 找一個「幾乎不可能活著」的 PID（已結束的 child）
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.once('exit', r));
    const deadPid = child.pid;
    // 確認真的 dead
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

    // 寫自己的 PID 進去，但把 mtime 設為 7 小時前
    await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });
    await fs.writeFile(LOCK_PATH, String(process.pid));
    const ancient = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await fs.utimes(LOCK_PATH, ancient, ancient);

    const got = await acquireLock();
    assert.equal(got, true, 'lock mtime > 6h → 視為 stale → 接手');
    await releaseLock();
  });
});
