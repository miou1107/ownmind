#!/usr/bin/env node
/**
 * OwnMind Reply Lint — Claude Code Stop Hook (v1.17.96)
 *
 * 設計目的（接 v1.17.95 + IR-027「提醒無效，邏輯才有效」）：
 *   v1.17.95 把 IR-037（中英混雜）+ IR-036（行話沒附白話說明）的判斷邏輯
 *   抽到 shared/language-lint.js 純函式 lib，但沒整合到任何卡關點 — AI
 *   還是靠自覺、IR-027 沒落地。
 *
 *   v1.17.96 在 Claude Code Stop hook（每輪 AI 回話結束時觸發）讀 transcript、
 *   抽最後一輪 assistant 的 text、跑 lintReply、違反就：
 *     1. 寫 banner 到 user terminal（重用 ownmind-tty-echo.cjs 的 writeToTty 邏輯）
 *     2. 寫 compliance event 到 ~/.ownmind/logs/YYYY-MM-DD.jsonl（給 MCP buffer 撿走）
 *        + best-effort POST /api/activity/batch（spool 是保底、POST 是快路徑）
 *
 * Vin 三條規格（沿用 v1.17.71 ownmind-tty-echo.cjs）：
 *   1. 嚴禁被 AI 過濾或吃掉 — 不寫 stderr / stdout / additionalContext
 *   2. 主路徑寫 /dev/tty (mac/linux) 或 \\.\CONOUT$ (Windows)、繞過 Claude Code hook output
 *   3. Fallback 寫 ~/.ownmind/logs/banner-pending.jsonl，下次 SessionStart 補印
 *
 * Stop hook stdin 規格（Claude Code 官方）：
 *   {
 *     session_id: string,
 *     transcript_path: string,    // ~/.claude/projects/<proj>/<session>.jsonl
 *     hook_event_name: 'Stop',
 *     stop_hook_active: boolean   // true 代表這次 Stop 是因為前一個 hook block 觸發
 *                                 // → 必須立刻退出避免無限迴圈
 *   }
 *
 * Transcript JSONL 格式（每行一個 message）：
 *   { type: 'assistant', message: { content: [{type: 'text', text: '...'}, ...] }, ... }
 *
 * Activity log schema（對齊 src/routes/activity.js batch handler、mcp/ownmind-log.js logEvent）：
 *   { ts: ISO8601, event: 'iron_rule_compliance', tool: 'claude-code',
 *     source: 'reply-lint-hook',
 *     details: { action: 'violate', rule_code, rule_title, ... } }
 *
 * 永遠 exit 0（不擋 AI 流程）。
 *
 * 環境變數（測試 / opt-out 用）：
 *   OWNMIND_TTY_FORCE_FALLBACK=1     強制走 fallback file（測試用）
 *   OWNMIND_TTY_OVERRIDE=<path>      tty 路徑改用這個檔（測試用）
 *   OWNMIND_REPLY_LINT_NO_NETWORK=1  禁止 POST /api/activity/batch（測試用）
 *   OWNMIND_REPLY_LINT_DISABLE=1     完全跳過 lint（user opt-out）
 *   OWNMIND_REPLY_LINT_API_URL       覆寫 API URL（測試用 fake server）
 */

// ============================================================
// IR-027 spec #3 (絕對): 永遠不寫 stderr / stdout
// 註冊 process-wide handlers 蓋住任何同步 / 非同步例外，
// 包括 import-time 失敗、unhandled rejection、uncaughtException。
// 這必須在任何其他邏輯前最早設定。
// ============================================================
process.on('uncaughtException', () => { try { process.exit(0); } catch { /* ignore */ } });
process.on('unhandledRejection', () => { try { process.exit(0); } catch { /* ignore */ } });

// 只 import Node built-ins（這些絕不會在 module load 時失敗）。
// 對 shared/* 模組改用 dynamic import 包在 try/catch 裡（v1.17.96 review A2）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const FORCE_FALLBACK = process.env.OWNMIND_TTY_FORCE_FALLBACK === '1';
const TTY_OVERRIDE = process.env.OWNMIND_TTY_OVERRIDE || '';
const NO_NETWORK = process.env.OWNMIND_REPLY_LINT_NO_NETWORK === '1';
const DISABLED = process.env.OWNMIND_REPLY_LINT_DISABLE === '1';
const API_URL_OVERRIDE = process.env.OWNMIND_REPLY_LINT_API_URL || '';

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PENDING_FILE = path.join(HOME, '.ownmind', 'logs', 'banner-pending.jsonl');
const PENDING_FILE_MAX_BYTES = 1024 * 1024;

// v1.17.97 — POST 失敗 / NO_NETWORK 才 spool 到這個檔；SessionStart 補送。
// 跟 archive YYYY-MM-DD.jsonl 分開：archive 是 debugging 用、pending 是 retry queue。
const COMPLIANCE_PENDING_FILE = path.join(HOME, '.ownmind', 'logs', 'reply-lint-pending.jsonl');

// 防呆：transcript 檔太大時只讀尾巴（避免巨大 session 拖慢 hook）。
// 一行 JSON 通常 < 50KB；256KB 足夠覆蓋最後 5+ 輪 messages。
const MAX_TRANSCRIPT_TAIL_BYTES = 256 * 1024;

// POST timeout — Stop hook 不該卡太久（user 等下一個 prompt）
const POST_TIMEOUT_MS = 1500;

main().catch(() => { try { process.exit(0); } catch { /* ignore */ } });

async function main() {
  if (DISABLED) { process.exit(0); return; }

  // dynamic import shared/* 包在 try：失敗也不外漏（review A2）
  // v1.19: 全部 shared/* 與 hooks/lib/* 統一 catch → exit 0、不再 inline fallback（review M-2）
  let lintReply, readCredentials, getClientVersion, getTierFromRules, buildComplianceEvents;
  try {
    ({ lintReply } = await import('../shared/language-lint.js'));
    ({ readCredentials, getClientVersion } = await import('../shared/helpers.js'));
    ({ getTierFromRules } = await import('../shared/iron-rule-tier.js'));
    ({ buildComplianceEvents } = await import('./lib/build-compliance-events.js'));
  } catch {
    process.exit(0); return;
  }

  let payload;
  try {
    const input = await readStdin();
    payload = safeParse(input);
  } catch { process.exit(0); return; }
  if (!payload) { process.exit(0); return; }

  // stop_hook_active=true 代表這次 Stop 是因為前一個 hook block 觸發
  // → 立刻退出避免無限迴圈（Claude Code Stop hook 規格）
  if (payload.stop_hook_active === true) { process.exit(0); return; }

  const transcriptPath = sanitizeTranscriptPath(payload.transcript_path);
  if (!transcriptPath) { process.exit(0); return; }

  const lastAssistantText = readLastAssistantText(transcriptPath);
  if (!lastAssistantText) { process.exit(0); return; }

  let lintResult;
  try { lintResult = lintReply(lastAssistantText); }
  catch { process.exit(0); return; }
  if (lintResult.ok) { process.exit(0); return; }

  // === Banner 路徑（給 user 看）===
  const block = formatBanner(lintResult.violations, getClientVersion);
  if (block) {
    const wrote = !FORCE_FALLBACK && writeToTty(block);
    if (!wrote) writeFallback(block);
  }

  // === Compliance event 路徑（跨 session 統計）===
  // 設計（v1.17.97 改）：
  //   1. archive 寫進 YYYY-MM-DD.jsonl（debugging、無 reader）— 保留 v1.17.96 行為
  //   2. await POST 嘗試送 server
  //   3. POST 失敗 / NO_NETWORK 才寫 reply-lint-pending.jsonl 給 SessionStart flush
  //      （POST 成功就不寫 pending、避免 flush 重複送、DB 不會有 duplicate）
  // v1.19: 讀 iron_rules cache 給每筆違反查 tier（best-effort、cache miss 用 default）
  const cachedRules = readIronRulesCache();
  const events = buildComplianceEvents(lintResult.violations, cachedRules, getTierFromRules);
  spoolEvents(events);

  let postOk = false;
  if (!NO_NETWORK) {
    try {
      postOk = await postEvents(events, readCredentials);
    } catch { postOk = false; }
  }
  if (!postOk) {
    spoolPendingForRetry(events);
  }

  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) { resolve(''); return; }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    setTimeout(() => resolve(buf), 1000).unref();
  });
}

function safeParse(s) {
  try { return JSON.parse(s || '{}'); }
  catch { return null; }
}

/**
 * 清洗 transcript_path（review B1 — defensive）：
 *   - 必須是字串
 *   - 必須以 .jsonl 結尾
 *   - realpath 後必須是 regular file（拒絕 symlink 指向奇怪地方）
 *   - 大小 > 0
 *
 * 註：Claude Code 自己控 stdin payload、不是真有攻擊者餵 path，
 *     但 Stop hook 是公開 surface area、寫防呆檢查比較安心。
 */
function sanitizeTranscriptPath(p) {
  if (!p || typeof p !== 'string') return null;
  if (!p.endsWith('.jsonl')) return null;
  let real;
  try { real = fs.realpathSync(p); }
  catch { return null; }
  let stat;
  try { stat = fs.lstatSync(real); }
  catch { return null; }
  if (!stat.isFile()) return null;
  if (stat.size === 0) return null;
  return real;
}

/**
 * 從 transcript JSONL 讀最後一輪 assistant 的純 text 內容（concat 多個 text part）。
 * 跳過 tool_use / thinking / 其他非 text part。
 *
 * 防呆：
 *   - 檔案大時只讀尾巴 256KB（最後一輪通常在末尾）
 *   - 尾巴讀法可能從某行中間切到 → 丟掉第一行（review B4）
 */
function readLastAssistantText(transcriptPath) {
  let buf;
  let truncatedHead = false;
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size <= MAX_TRANSCRIPT_TAIL_BYTES) {
      buf = fs.readFileSync(transcriptPath, 'utf8');
    } else {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const chunk = Buffer.alloc(MAX_TRANSCRIPT_TAIL_BYTES);
        fs.readSync(fd, chunk, 0, MAX_TRANSCRIPT_TAIL_BYTES, stat.size - MAX_TRANSCRIPT_TAIL_BYTES);
        buf = chunk.toString('utf8');
        truncatedHead = true;
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return null;
  }

  let lines = buf.split('\n').filter(Boolean);
  // truncatedHead=true 時第一行可能從某筆 JSON 中間切起 → 丟掉（review B4）
  if (truncatedHead && lines.length > 0) lines = lines.slice(1);

  // 從後往前找第一筆 type=assistant
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = safeParse(lines[i]);
    if (!entry || entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    const texts = content
      .filter(p => p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text);
    if (texts.length === 0) continue;
    return texts.join('\n');
  }
  return null;
}

/**
 * 把 lint violations 包成招牌格式（沿用 ownmind-tty-echo.cjs 視覺風格）。
 *
 * 範例：
 *   【OwnMind v1.17.96】回話品質 lint
 *     ⚠️  IR-037: 中英混雜比例 32% > 15% — refactor, codebase, ...
 *     ⚠️  IR-036: 行話沒附白話說明 — refactor, hook
 */
function formatBanner(violations, getClientVersion) {
  if (!Array.isArray(violations) || violations.length === 0) return null;
  let version;
  try { version = getClientVersion(); } catch { version = '?'; }
  const out = [];
  out.push(`【OwnMind v${version}】回話品質 lint`);
  for (const v of violations) {
    out.push(`  ⚠️  ${v.rule}: ${v.message}`);
  }
  return out.join('\n');
}

/**
 * 寫到 user terminal device。成功 true、失敗 false。
 * 絕不寫 stderr / stdout（會被 Claude Code 當 hook 通道吃掉 → AI 看到）。
 */
function writeToTty(block) {
  const ttyPath = TTY_OVERRIDE || (process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty');
  let fd = null;
  try {
    fd = fs.openSync(ttyPath, 'a');
    fs.writeSync(fd, '\n' + block + '\n');
    fs.closeSync(fd);
    return true;
  } catch {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    return false;
  }
}

function writeFallback(block) {
  try {
    const dir = path.dirname(PENDING_FILE);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const stat = fs.statSync(PENDING_FILE);
      if (stat.size > PENDING_FILE_MAX_BYTES) {
        try { fs.renameSync(PENDING_FILE, PENDING_FILE + '.old'); } catch { /* ignore */ }
      }
    } catch { /* file 不存在 → skip */ }
    const record = { ts: new Date().toISOString(), block };
    fs.appendFileSync(PENDING_FILE, JSON.stringify(record) + '\n');
  } catch { /* swallow */ }
}

/**
 * Compliance events — schema 對齊 src/routes/activity.js batch handler 要求：
 *   { ts, event, tool, source, details, client_event_id }
 * 缺 ts 或 event 會被 server 直接 continue 跳過（不落 DB）。
 *
 * details.rule_code + details.action 是 pitfalls / dashboard 後續查詢用的關鍵欄位
 * （對齊 mcp/index.js 的 report_compliance 寫法）。
 *
 * v1.17.98: client_event_id (uuid v4) — server 用 (user_id, client_event_id)
 * partial unique index ON CONFLICT DO NOTHING 做 dedup，解掉 hook POST timeout
 * 又被 SessionStart flush 重送 / 兩個 SessionStart 並發等 race 場景。
 * 同一個違反在 hook 跟 flush 兩條路徑必須帶同一個 id 才有效；所以 id 在這裡產一次、
 * banner / archive / pending 都用同一個。
 */
// v1.19: 抽到 hooks/lib/build-compliance-events.js 給單元測試用
//   buildComplianceEvents(violations, rules, getTier) — dynamic import 在 main() 內

/**
 * v1.19: 讀本地 iron_rules cache 給 tier 查詢用
 * 純 best-effort、cache 不存在或解析失敗一律回空陣列、不擋主流程
 */
function readIronRulesCache() {
  try {
    const cachePath = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');
    if (!fs.existsSync(cachePath)) return [];
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Archive 寫到 ~/.ownmind/logs/YYYY-MM-DD.jsonl（同 mcp/ownmind-log.js LOGS_DIR）。
 * 純 debugging / human-readable 用、目前沒 reader 主動撿走（v1.17.97 確認）。
 * 不丟錯：寫不進去也不該擋 hook 流程。
 */
function spoolEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return;
  try {
    const logsDir = path.join(HOME, '.ownmind', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = path.join(logsDir, `${dateStr}.jsonl`);
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(filePath, lines);
  } catch { /* swallow */ }
}

/**
 * v1.17.97 — POST 失敗時 spool 到 reply-lint-pending.jsonl 等下次 SessionStart flush。
 * Append-only：既有內容保留、新事件加在後面。
 *
 * Size cap（review N1）：超過 1MB rotate 成 .old 覆蓋舊的，避免長期離線無限長。
 *
 * 不丟錯。
 */
const COMPLIANCE_PENDING_MAX_BYTES = 1024 * 1024;

function spoolPendingForRetry(events) {
  if (!Array.isArray(events) || events.length === 0) return;
  try {
    const dir = path.dirname(COMPLIANCE_PENDING_FILE);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const stat = fs.statSync(COMPLIANCE_PENDING_FILE);
      if (stat.size > COMPLIANCE_PENDING_MAX_BYTES) {
        try { fs.renameSync(COMPLIANCE_PENDING_FILE, COMPLIANCE_PENDING_FILE + '.old'); } catch { /* ignore */ }
      }
    } catch { /* file 不存在 → skip */ }
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(COMPLIANCE_PENDING_FILE, lines);
  } catch { /* swallow */ }
}

/**
 * Best-effort POST events 到 /api/activity/batch。
 * await 直到 socket flush 完才 resolve（review B2 — 避免 process.exit 砍 socket）。
 * 1500ms timeout，超過就 destroy + resolve(false)。
 *
 * @returns {Promise<boolean>} true 代表 HTTP 2xx；其他狀況回 false 讓上層走 spool retry。
 */
function postEvents(events, readCredentials) {
  return new Promise((resolve) => {
    if (!Array.isArray(events) || events.length === 0) { resolve(false); return; }
    let apiKey = '', apiUrl = '';
    try {
      ({ apiKey, apiUrl } = readCredentials());
    } catch { resolve(false); return; }
    if (API_URL_OVERRIDE) apiUrl = API_URL_OVERRIDE;
    if (!apiKey || !apiUrl) { resolve(false); return; }

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
        // HTTP 2xx 才算成功；4xx/5xx 算失敗、走 spool retry
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
