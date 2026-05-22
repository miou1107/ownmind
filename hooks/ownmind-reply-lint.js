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

// v1.19.3：MODE env、漸進式 block
// v1.19.4：預設從 warn 翻成 block（IR-027 邏輯才有效——opt-in 等於沒落地）
// - block（預設）：違規累積到 BLOCK_THRESHOLD（4 次）後寫 stdout JSON 觸發 Claude 重寫
//                  前 3 次只警告（漸進緩衝、避免單一誤判毀對話）
// - warn：違規寫 banner、永遠不 block（opt-out、給覺得太煩的 user）
// - disable：完全跳過（同 OWNMIND_REPLY_LINT_DISABLE=1）
// - 未知值（fail-open）：當 warn 處理 + banner 加提示
const RAW_MODE = (process.env.OWNMIND_REPLY_LINT_MODE || 'block').toLowerCase();
const VALID_MODES = new Set(['warn', 'block', 'disable']);
const MODE = VALID_MODES.has(RAW_MODE) ? RAW_MODE : 'warn';
const MODE_INVALID = !VALID_MODES.has(RAW_MODE);
const BLOCK_THRESHOLD = 4;  // 第 4 次違規才 block（前 3 次警告）
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 天

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
  // v1.19.3: MODE=disable 等同舊 DISABLED env
  if (DISABLED || MODE === 'disable') { process.exit(0); return; }

  // dynamic import shared/* 包在 try：失敗也不外漏（review A2）
  // v1.19: 全部 shared/* 與 hooks/lib/* 統一 catch → exit 0、不再 inline fallback（review M-2）
  // v1.19.3: 新增 session-counter
  let lintReply, readCredentials, getClientVersion, getTierFromRules, buildComplianceEvents;
  let incrementCounter, cleanupStale;
  try {
    ({ lintReply } = await import('../shared/language-lint.js'));
    ({ readCredentials, getClientVersion } = await import('../shared/helpers.js'));
    ({ getTierFromRules } = await import('../shared/iron-rule-tier.js'));
    ({ buildComplianceEvents } = await import('./lib/build-compliance-events.js'));
    ({ incrementCounter, cleanupStale } = await import('./lib/session-counter.js'));
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
  // v1.19.3：這也保證 Claude 重寫過程的 Stop 不會被重複計數
  if (payload.stop_hook_active === true) { process.exit(0); return; }

  const transcriptPath = sanitizeTranscriptPath(payload.transcript_path);
  if (!transcriptPath) { process.exit(0); return; }

  const lastAssistantText = readLastAssistantText(transcriptPath);
  if (!lastAssistantText) { process.exit(0); return; }

  let lintResult;
  try { lintResult = lintReply(lastAssistantText); }
  catch { process.exit(0); return; }
  if (lintResult.ok) { process.exit(0); return; }

  // === v1.19.3: 計數累積 + 決定是否 block ===
  const sessionId = (typeof payload.session_id === 'string' && payload.session_id) || 'unknown';
  let currentCount = 1;  // 預設 1（incrementCounter 失敗時的 fallback）
  try { currentCount = incrementCounter(sessionId); } catch { /* swallow */ }
  // best-effort 自掃過期 session（每次 hook 觸發跑一下、避免檔無限長）
  try { cleanupStale(SESSION_TTL_MS); } catch { /* swallow */ }

  const shouldBlock = MODE === 'block' && currentCount >= BLOCK_THRESHOLD;

  // === Banner 路徑（給 user 看）===
  const banner = formatBanner(lintResult.violations, getClientVersion, {
    mode: MODE,
    modeInvalid: MODE_INVALID,
    rawMode: RAW_MODE,
    count: currentCount,
    threshold: BLOCK_THRESHOLD,
    blocked: shouldBlock,
  });
  if (banner) {
    const wrote = !FORCE_FALLBACK && writeToTty(banner);
    if (!wrote) writeFallback(banner);
  }

  // === v1.19.3: 寫 block decision JSON 到 stdout（Claude Code 觸發 Claude 重寫）===
  // 順序：stdout 先寫、其他工作後做（避免 POST timeout 卡住 block signal）
  if (shouldBlock) {
    const reason = formatBlockReason(lintResult.violations);
    try {
      process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
    } catch { /* 寫不出也吞、Claude Code 收不到 block 就算了、退化成 warn 模式 */ }
  }

  // === Compliance event 路徑（跨 session 統計）===
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
 * v1.19.3：加 MODE 與 session 計數顯示
 *
 * 範例（warn mode）：
 *   【OwnMind v1.19.3】回話品質 lint（warn mode、本 session 累積 1 次）
 *     ⚠️  IR-037: 中英混雜比例 32% > 15% — refactor, codebase, ...
 *
 * 範例（block mode、第 3 次預告）：
 *   【OwnMind v1.19.3】回話品質 lint（block mode、本 session 累積 3 次、下次違規會 block）
 *
 * 範例（block mode、第 4 次觸發 block）：
 *   【OwnMind v1.19.3】回話品質 lint ⚠️ 已觸發 block、Claude 將收到重寫指令
 */
function formatBanner(violations, getClientVersion, opts = {}) {
  if (!Array.isArray(violations) || violations.length === 0) return null;
  let version;
  try { version = getClientVersion(); } catch { version = '?'; }

  const { mode = 'warn', modeInvalid = false, rawMode = '', count = 1, threshold = 4, blocked = false } = opts;

  const out = [];
  let header = `【OwnMind v${version}】回話品質 lint`;
  if (blocked) {
    header += ` ⚠️ 已觸發 block、Claude 將收到重寫指令（本 session 累積 ${count} 次）`;
  } else if (mode === 'block') {
    const remaining = Math.max(0, threshold - count);
    header += `（block mode、本 session 累積 ${count} 次、再 ${remaining} 次就 block）`;
  } else {
    header += `（${mode} mode、本 session 累積 ${count} 次）`;
  }
  out.push(header);

  if (modeInvalid) {
    out.push(`  ⚠️  OWNMIND_REPLY_LINT_MODE='${rawMode}' 不認識、fallback 到 warn`);
  }

  for (const v of violations) {
    out.push(`  ⚠️  ${v.rule}: ${v.message}`);
  }
  return out.join('\n');
}

/**
 * v1.19.3：把 violations 包成「指令型」reason、給 Claude Code block 後餵 Claude 當下一個 prompt
 *
 * Codex 對抗審查警告：reason 是「下一個 prompt」、不是「修正指令」。
 *   ❌ 報告型：「你違反 IR-037、比例 32%、找到 5 個英文詞」
 *   ✅ 指令型：「請重寫剛才那則回應、用白話中文取代以下英文詞...」
 *
 * 重寫提示要：
 *   1. 用動詞「請重寫」開頭
 *   2. 列出具體問題詞、Claude 才知道改哪些
 *   3. 給改寫格式範例（白話、括號附中文等）
 *   4. 加例外指引（變數名 / 函式名等不用改）、避免 Claude 把 code 也改壞
 */
function formatBlockReason(violations) {
  const lines = [];
  lines.push('請重寫你剛才的回應、改善以下品質問題（保持原意、只改語言風格）：');
  lines.push('');

  for (const v of violations) {
    if (v.rule === 'IR-037') {
      const words = (v.detail && Array.isArray(v.detail.mixedWords)) ? v.detail.mixedWords.slice(0, 10) : [];
      lines.push(`1. 用白話中文取代以下英文詞（或在第一次出現時用括號附中文解釋）：`);
      if (words.length > 0) {
        lines.push(`   ${words.join(', ')}`);
      }
      lines.push('');
    } else if (v.rule === 'IR-036') {
      const words = (v.detail && Array.isArray(v.detail.jargon)) ? v.detail.jargon.slice(0, 10) : [];
      lines.push(`2. 以下技術詞第一次出現時要附白話說明、用「：解釋」、「（白話）」、「即...」、「也就是...」等格式：`);
      if (words.length > 0) {
        lines.push(`   ${words.join(', ')}`);
      }
      lines.push('');
    }
  }

  lines.push('如果上述詞屬於變數名 / 函式名 / 程式碼引用、或上下文已說明過、可保留不改。');
  lines.push('重寫時請回到原本對話脈絡、不要重新確認問題、直接給新答案。');

  return lines.join('\n');
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
