#!/usr/bin/env node
/**
 * hooks/ownmind-usage-scanner.js
 *
 * 主 entry：依序 call 各 tool 的 adapter、走同一 `runScan()` 流程、送 events + heartbeat。
 * Plan P4：目前只掛 claude-code 一個 adapter；P5 加 codex、opencode。
 *
 * Install 完成後由 launchd / systemd / Task Scheduler 每 30 分鐘呼叫一次（P6）。
 */

import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { readCredentials, getClientVersion } from '../shared/helpers.js';
import { runScan } from '../shared/scanners/base.js';
import { createClaudeCodeAdapter } from '../shared/scanners/claude-code.js';
import { createCodexAdapter } from '../shared/scanners/codex.js';
import { createOpenCodeAdapter } from '../shared/scanners/opencode.js';

const HOME = os.homedir();
const LOG_PATH = path.join(HOME, '.ownmind', 'logs', 'scanner.log');
const LOCK_PATH = path.join(HOME, '.ownmind', 'cache', 'scanner.lock');

async function log(line) {
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fs.appendFile(LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

const STALE_LOCK_MS = 6 * 60 * 60 * 1000;  // 6 小時

/**
 * 自我 lock：避免 cron 撞上手動跑的 scanner。
 *
 * 使用 O_EXCL 建立 lock 檔；已存在時：
 *   1. 讀檔內 PID，若該 process 已消失（`kill -0` ESRCH）→ 視為 stale、接手
 *   2. 或 lock 檔 mtime 超過 6 小時 → 視為 stale、接手
 *   3. 否則假設另一實例還活著，回 false
 *
 * 避免 SIGKILL / OOM / laptop sleep 後 lock 孤兒，永遠擋住後續 scan。
 */
async function acquireLock() {
  await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });

  while (true) {
    try {
      const handle = await fs.open(LOCK_PATH, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    // Lock 已存在 — 檢查是否 stale
    let stale = false;
    try {
      const raw = await fs.readFile(LOCK_PATH, 'utf8');
      const otherPid = parseInt(raw.trim(), 10);
      if (Number.isFinite(otherPid) && otherPid > 0 && otherPid !== process.pid) {
        try {
          process.kill(otherPid, 0);  // 存在則回傳；不存在則 throw ESRCH
        } catch (e) {
          if (e.code === 'ESRCH') stale = true;
        }
      }
      if (!stale) {
        const st = await fs.stat(LOCK_PATH);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) stale = true;
      }
    } catch {
      // 讀不到就當 stale，重建
      stale = true;
    }

    if (!stale) return false;

    // 刪掉 stale lock 再 retry 一次（仍用 wx 避免 race）
    try { await fs.unlink(LOCK_PATH); } catch { /* 另一 process 剛接手也 OK */ }
  }
}

async function releaseLock() {
  try { await fs.unlink(LOCK_PATH); } catch { /* best-effort */ }
}

async function main() {
  const locked = await acquireLock();
  if (!locked) {
    await log('[scanner] another instance is running (lock exists), skipping');
    return;
  }

  try {
    const { apiKey, apiUrl } = readCredentials();
    if (!apiKey || !apiUrl) {
      await log('[scanner] credentials not found; skipping');
      return;
    }

    const scannerVersion = getClientVersion() || 'unknown';
    const machine = os.hostname();

    const adapters = [
      createClaudeCodeAdapter({ scannerVersion, machine }),
      createCodexAdapter({ scannerVersion, machine }),
      createOpenCodeAdapter({ scannerVersion, machine })
    ];

    for (const adapter of adapters) {
      try {
        const result = await runScan({ adapter, apiUrl, apiKey });
        await log(`[scanner] ${adapter.tool} ` +
          `sent=${result.sent} accepted=${result.accepted} duplicated=${result.duplicated} ` +
          `batches=${result.batches}`);
      } catch (err) {
        await log(`[scanner] ${adapter.tool} failed: ${err.message}`);
      }
    }
  } finally {
    await releaseLock();
  }
}

export { main, acquireLock, releaseLock };

// 只在直接執行時才跑 main；import 時不觸發（測試友善）
// fileURLToPath 處理 Windows 反斜線與 URL 編碼差異，`import.meta.url` 字串比對在 Win 會失敗
const isDirectRun = process.argv[1] && (() => {
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); }
  catch { return false; }
})();
if (isDirectRun) {
  main().catch(async (err) => {
    await log(`[scanner] fatal: ${err.message}`);
    try { await releaseLock(); } catch { /* ignore */ }
    process.exit(1);
  });
}
