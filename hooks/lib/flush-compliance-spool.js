#!/usr/bin/env node
/**
 * v1.17.97 — flush ~/.ownmind/logs/reply-lint-pending.jsonl 到 server
 *
 * 由 ownmind-session-start.sh 在 banner-pending flush 之後呼叫。
 *
 * 流程：
 *   1. 沒檔 → 立刻 exit 0
 *   2. 有檔但全壞行 → 刪檔 exit 0（避免每次都重試永遠送不出去的內容）
 *   3. 有檔且有可 parse 行 → 一次 POST /api/activity/batch
 *      - HTTP 2xx → 刪檔（事件已落 server DB）
 *      - 其他狀況 → 留檔等下次 SessionStart 再試
 *
 * Vin spec #3：永不寫 stderr / stdout（SessionStart 通道使用者看得到）。
 * 永遠 exit 0、永不阻擋 SessionStart。
 *
 * 環境變數（測試用）：
 *   OWNMIND_FLUSH_API_URL — 覆寫 API URL（fake server 測試）
 */

// 防護：所有錯誤吞掉、絕不洩漏到 stderr
process.on('uncaughtException', () => { try { process.exit(0); } catch { /* ignore */ } });
process.on('unhandledRejection', () => { try { process.exit(0); } catch { /* ignore */ } });

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PENDING_FILE = path.join(HOME, '.ownmind', 'logs', 'reply-lint-pending.jsonl');
const API_URL_OVERRIDE = process.env.OWNMIND_FLUSH_API_URL || '';
const POST_TIMEOUT_MS = 3000;  // SessionStart 比 Stop 寬鬆、3s 可接受

main().catch(() => { try { process.exit(0); } catch { /* ignore */ } });

async function main() {
  if (!fs.existsSync(PENDING_FILE)) { process.exit(0); return; }

  // v1.17.97 review I2 fix — rename → process → unlink，避免 read-then-delete race：
  //   原本流程 read → POST → unlink 的 POST 期間（數百 ms ~ 3s）若 hook 新寫入
  //   一筆事件，POST 成功後 unlink 會把那筆新事件一起刪掉、永久遺失。
  //   改用 rename 把 in-flight 區塊隔離出來、新事件去寫一個全新的空檔。
  //
  //   順帶解 Concern #2 同 SessionStart 並發：兩個 flush 同時跑、第一個 rename
  //   成功、第二個 rename 失敗 ENOENT → 第二個直接 exit 0。
  //
  //   .processing-<ts>-<pid> 後綴：避免兩個 flush 萬一在不同檔系上看到不同 PENDING
  //   生命週期時、processing 檔互相覆蓋。
  const processingFile = `${PENDING_FILE}.processing-${Date.now()}-${process.pid}`;
  try {
    fs.renameSync(PENDING_FILE, processingFile);
  } catch {
    // ENOENT — 別的 flush 已搶走、或檔被刪了；不是錯
    process.exit(0); return;
  }

  let raw;
  try { raw = fs.readFileSync(processingFile, 'utf8'); }
  catch { restoreOrCleanup(processingFile); process.exit(0); return; }
  if (!raw.trim()) {
    safeUnlinkPath(processingFile);
    process.exit(0); return;
  }

  // 解析每行；壞行跳過
  const lines = raw.split('\n').filter(l => l.trim());
  const events = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      // 至少要有 ts + event 否則 server batch handler 會 continue 跳過
      if (ev && ev.ts && ev.event) events.push(ev);
    } catch { /* 壞行跳過 */ }
  }

  if (events.length === 0) {
    // 全壞行 → 直接清掉 processing、不要每次 SessionStart 都重試永遠送不出去的內容
    safeUnlinkPath(processingFile);
    process.exit(0); return;
  }

  // 讀 credentials — inline 而不 import shared/helpers.js，因為這個 helper 會被
  // install.sh 複製到 ~/.claude/hooks/lib/、跨目錄 relative import shared/
  // 解析不到（shared 在 ~/.ownmind/shared/）。
  let { apiKey, apiUrl } = readCredentialsInline();
  if (API_URL_OVERRIDE) apiUrl = API_URL_OVERRIDE;
  if (!apiKey || !apiUrl) {
    // 沒 credentials → 把 processing 還原成 pending 等下次再試（user 可能還在配 OwnMind）
    restoreOrCleanup(processingFile);
    process.exit(0); return;
  }

  const ok = await postEvents(events, apiKey, apiUrl);
  if (ok) {
    // POST 200 → 安全刪 processing 檔（hook 在這段時間若新寫事件、是寫到全新的
    // PENDING_FILE、跟 processing 完全分離）
    safeUnlinkPath(processingFile);
  } else {
    // POST 失敗 → 把 processing 還原成 pending、等下次 SessionStart 重試
    restoreOrCleanup(processingFile);
  }
  process.exit(0);
}

function safeUnlinkPath(p) {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

/**
 * 把 processing 檔還原成 pending 檔等下次重試。
 * 若 PENDING_FILE 已存在（hook 在這期間新寫入）→ append processing 內容後刪 processing。
 * 全部失敗就放著、處理檔永遠留著總比丟資料好。
 */
function restoreOrCleanup(processingFile) {
  try {
    if (!fs.existsSync(processingFile)) return;
    if (!fs.existsSync(PENDING_FILE)) {
      try { fs.renameSync(processingFile, PENDING_FILE); return; } catch { /* fall through */ }
    }
    // PENDING 已被新寫入 → 把 processing 內容 append 過去
    const data = fs.readFileSync(processingFile);
    fs.appendFileSync(PENDING_FILE, data);
    safeUnlinkPath(processingFile);
  } catch { /* 失敗就留 .processing 檔、人工處理 */ }
}

/**
 * 讀 ~/.claude/settings.json 拿 OwnMind credentials。
 * 對齊 shared/helpers.js readCredentials 行為，但 inline、不 import（避免跨目錄解析）。
 * 容忍 UTF-8 BOM（Windows PS 5.1 Set-Content -Encoding UTF8 會加 BOM）。
 */
function readCredentialsInline() {
  try {
    const settingsPath = path.join(HOME, '.claude', 'settings.json');
    let raw = fs.readFileSync(settingsPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const s = JSON.parse(raw);
    const env = s.mcpServers?.ownmind?.env || {};
    return { apiKey: env.OWNMIND_API_KEY || '', apiUrl: env.OWNMIND_API_URL || '' };
  } catch {
    return { apiKey: '', apiUrl: '' };
  }
}

function postEvents(events, apiKey, apiUrl) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/api/activity/batch', apiUrl); }
    catch { resolve(false); return; }

    const body = JSON.stringify({ events });
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok === true); } };

    let req;
    try {
      req = mod.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: POST_TIMEOUT_MS,
      }, (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        res.on('data', () => { /* drain */ });
        res.on('end', () => done(ok));
        res.on('error', () => done(false));
      });
    } catch { resolve(false); return; }

    req.on('error', () => done(false));
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } done(false); });
    try { req.write(body); req.end(); }
    catch { done(false); }
  });
}
