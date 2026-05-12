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

const FORCE_FALLBACK = process.env.OWNMIND_TTY_FORCE_FALLBACK === '1';
const TTY_OVERRIDE = process.env.OWNMIND_TTY_OVERRIDE || '';
const NO_NETWORK = process.env.OWNMIND_REPLY_LINT_NO_NETWORK === '1';
const DISABLED = process.env.OWNMIND_REPLY_LINT_DISABLE === '1';
const API_URL_OVERRIDE = process.env.OWNMIND_REPLY_LINT_API_URL || '';

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PENDING_FILE = path.join(HOME, '.ownmind', 'logs', 'banner-pending.jsonl');
const PENDING_FILE_MAX_BYTES = 1024 * 1024;

// 防呆：transcript 檔太大時只讀尾巴（避免巨大 session 拖慢 hook）。
// 一行 JSON 通常 < 50KB；256KB 足夠覆蓋最後 5+ 輪 messages。
const MAX_TRANSCRIPT_TAIL_BYTES = 256 * 1024;

// POST timeout — Stop hook 不該卡太久（user 等下一個 prompt）
const POST_TIMEOUT_MS = 1500;

main().catch(() => { try { process.exit(0); } catch { /* ignore */ } });

async function main() {
  if (DISABLED) { process.exit(0); return; }

  // dynamic import shared/* 包在 try：失敗也不外漏（review A2）
  let lintReply, readCredentials, getClientVersion;
  try {
    ({ lintReply } = await import('../shared/language-lint.js'));
    ({ readCredentials, getClientVersion } = await import('../shared/helpers.js'));
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
  // 設計：先 spool 到 daily JSONL（durability、絕不漏）、再 best-effort POST。
  // POST 失敗或 process exit 早於 socket flush 都不會丟資料。
  const events = buildComplianceEvents(lintResult.violations);
  spoolEvents(events);

  if (!NO_NETWORK) {
    // 用 await + 1500ms timeout — 確保 socket 真的 flush 才 exit（review B2）
    try { await postEvents(events, readCredentials); }
    catch { /* swallow — spool 已寫入、不會丟資料 */ }
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
 *   { ts, event, tool, source, details }
 * 缺 ts 或 event 會被 server 直接 continue 跳過（不落 DB）。
 *
 * details.rule_code + details.action 是 pitfalls / dashboard 後續查詢用的關鍵欄位
 * （對齊 mcp/index.js 的 report_compliance 寫法）。
 */
function buildComplianceEvents(violations) {
  const ts = new Date().toISOString();
  return violations.map(v => ({
    ts,
    event: 'iron_rule_compliance',
    tool: 'claude-code',
    source: 'reply-lint-hook',
    details: {
      action: 'violate',
      rule_code: v.rule,
      // 截掉訊息避免 DB 暴大
      message: typeof v.message === 'string' ? v.message.slice(0, 300) : '',
    },
  }));
}

/**
 * Spool 到 ~/.ownmind/logs/YYYY-MM-DD.jsonl（同 mcp/ownmind-log.js LOGS_DIR）。
 * 這是 durability 保底 — 即使 POST 完全失敗、event 還是落地、之後可重送。
 *
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
 * Best-effort POST events 到 /api/activity/batch。
 * await 直到 socket flush 完才 resolve（review B2 — 避免 process.exit 砍 socket）。
 * 1500ms timeout，超過就 destroy + resolve。
 */
function postEvents(events, readCredentials) {
  return new Promise((resolve) => {
    if (!Array.isArray(events) || events.length === 0) { resolve(); return; }
    let apiKey = '', apiUrl = '';
    try {
      ({ apiKey, apiUrl } = readCredentials());
    } catch { resolve(); return; }
    if (API_URL_OVERRIDE) apiUrl = API_URL_OVERRIDE;
    if (!apiKey || !apiUrl) { resolve(); return; }

    let u;
    try { u = new URL('/api/activity/batch', apiUrl); }
    catch { resolve(); return; }

    const body = JSON.stringify({ events });
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

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
        res.on('data', () => { /* drain */ });
        res.on('end', done);
        res.on('error', done);
      });
    } catch { resolve(); return; }

    req.on('error', done);
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } done(); });
    try { req.write(body); req.end(); }
    catch { done(); }
  });
}
