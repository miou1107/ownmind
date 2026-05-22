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
// v1.19.7：block 路徑改用 exit 2 + stderr reason（取代 stdout JSON），新增連續 block 達
//          BLOCK_DOWNGRADE_LIMIT 次後降警告（避免 AI 死循環、給 user 手動介入機會）
// - block（預設）：違規累積到 BLOCK_THRESHOLD（4 次）後 exit 2 + stderr 觸發 Claude 重寫
//                  前 3 次只警告（漸進緩衝、避免單一誤判毀對話）
//                  連續 block 達 3 次仍違反 → 降警告 exit 1（防死循環）
// - warn：違規寫 banner、永遠不 block（opt-out、給覺得太煩的 user）
// - disable：完全跳過（同 OWNMIND_REPLY_LINT_DISABLE=1）
// - 未知值（fail-open）：當 warn 處理 + banner 加提示
const RAW_MODE = (process.env.OWNMIND_REPLY_LINT_MODE || 'block').toLowerCase();
const VALID_MODES = new Set(['warn', 'block', 'disable']);
const MODE = VALID_MODES.has(RAW_MODE) ? RAW_MODE : 'warn';
const MODE_INVALID = !VALID_MODES.has(RAW_MODE);
const BLOCK_THRESHOLD = 4;  // 第 4 次違規才 block（前 3 次警告）
const BLOCK_DOWNGRADE_LIMIT = 3;  // v1.19.7：已連續 block 這麼多次後、下次違規降警告
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
  let incrementCounter, cleanupStale, incrementBlockCount, readBlockCount, resetBlockCount;
  let detectPrivacyLeak;
  let writeLintEvent, extractViolatedWords;
  try {
    ({ lintReply } = await import('../shared/language-lint.js'));
    ({ readCredentials, getClientVersion } = await import('../shared/helpers.js'));
    ({ getTierFromRules } = await import('../shared/iron-rule-tier.js'));
    ({ buildComplianceEvents } = await import('./lib/build-compliance-events.js'));
    ({
      incrementCounter,
      cleanupStale,
      incrementBlockCount,
      readBlockCount,
      resetBlockCount,
    } = await import('./lib/session-counter.js'));
    ({ detectPrivacyLeak } = await import('../shared/privacy-detect.js'));
    ({
      writeEvent: writeLintEvent,
      extractViolatedWords,
    } = await import('./lib/lint-event-logger.js'));
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

  // v1.19.12：一次讀 transcript 同時抽 last assistant text + 最近 user prompts
  // （取代 v1.19.7 的兩次 statSync + readFileSync、I/O 減半）
  // user prompts 給 privacy detector 當例外比對來源：使用者自己提到的個資、AI 引用不算外洩
  // 註：使用者若有對應的隱私鐵律（例如 Vin 的 IR-041）、會收到事件編號 'privacy_check'
  //     再由各自的鐵律判斷要不要擋；hook 本身不綁特定使用者編號（v1.19.10 中性化調整）
  const { lastAssistantText, recentUserPrompts: userPrompts } = readTranscriptTail(transcriptPath);
  if (!lastAssistantText) { process.exit(0); return; }

  const sessionId = (typeof payload.session_id === 'string' && payload.session_id) || 'unknown';

  let lintResult;
  try { lintResult = lintReply(lastAssistantText); }
  catch { process.exit(0); return; }

  // v1.19.7 引入、v1.19.10 中性化：加掛隱私偵測、事件名 'privacy_check'
  // 此事件由各使用者自己的鐵律判斷要不要擋（Vin 設了 IR-041 對應此事件、其他使用者
  // 可自行設定要不要寫成鐵律啟用）
  let privacyResult = { detected: false, matches: [] };
  try {
    privacyResult = detectPrivacyLeak(lastAssistantText, { userPrompts });
  } catch { /* 偵測本身錯不該擋主流程 */ }
  const violations = Array.isArray(lintResult.violations) ? [...lintResult.violations] : [];
  if (privacyResult.detected) {
    violations.push({
      rule: 'privacy_check',
      message: `偵測到個資外洩樣式 — ${privacyResult.matches.length} 處（${formatPrivacySummary(privacyResult.matches)}）。請改寫掉、或改用代稱`,
      detail: { matches: privacyResult.matches },
    });
  }

  const combinedOk = violations.length === 0;
  if (combinedOk) {
    // v1.19.7：通過時清零 block_count、讓下個 turn 的計數重新開始
    try { resetBlockCount(sessionId); } catch { /* swallow */ }
    process.exit(0); return;
  }

  // === v1.19.3: 違規計數累積 + 決定是否 block ===
  //
  // v1.19.7 code-review M-1 partial-failure window 註記：
  // 違規路徑的寫入順序是 count → block_count（達門檻時）→ stderr → compliance event
  //（spool / POST）。若 hook 被 SIGKILL 等強制終止、可能落在中間任意點：
  //   - count 已 +1 但 block_count 未 +1：下次 hook 仍會走正常 block 路徑、
  //     最多多警告 1 次、無資料損壞
  //   - block_count 已 +1 但 compliance event 未寫：admin 看不到該筆 block 紀錄、
  //     但 hook 行為仍正確
  // 這是可接受的觀測性退化（observability degradation：意指統計資料殘缺、
  // 但實際擋下邏輯沒受影響）。Stop hook 不該為了交易完整性引入 fsync。
  let currentCount = 1;  // 預設 1（incrementCounter 失敗時的 fallback）
  try { currentCount = incrementCounter(sessionId); } catch { /* swallow */ }
  // best-effort 自掃過期 session（每次 hook 觸發跑一下、避免檔無限長）
  try { cleanupStale(SESSION_TTL_MS); } catch { /* swallow */ }

  const reachedBlockThreshold = MODE === 'block' && currentCount >= BLOCK_THRESHOLD;

  // === v1.19.7：連續 block 達門檻 → 降警告（防 AI 死循環）===
  let priorBlockCount = 0;
  try { priorBlockCount = readBlockCount(sessionId); } catch { /* swallow */ }
  const downgradeToWarning = reachedBlockThreshold && priorBlockCount >= BLOCK_DOWNGRADE_LIMIT;
  const shouldHardBlock = reachedBlockThreshold && !downgradeToWarning;

  // === Banner 路徑（給 user 看）===
  const banner = formatBanner(violations, getClientVersion, {
    mode: MODE,
    modeInvalid: MODE_INVALID,
    rawMode: RAW_MODE,
    count: currentCount,
    threshold: BLOCK_THRESHOLD,
    blocked: shouldHardBlock,
    downgraded: downgradeToWarning,
    blockCount: priorBlockCount,
  });
  if (banner) {
    const wrote = !FORCE_FALLBACK && writeToTty(banner);
    if (!wrote) writeFallback(banner);
  }

  // === v1.19.7：block reason 寫 stderr 給 Claude / user 看（取代舊 stdout JSON）===
  let exitCode = 0;
  if (shouldHardBlock) {
    try { incrementBlockCount(sessionId); } catch { /* swallow */ }
    const reason = formatBlockReason(violations, { priorBlockCount });
    try { process.stderr.write(reason + '\n'); } catch { /* ignore */ }
    exitCode = 2;

    // v1.19.11：寫結構化擋下事件、為自學機制鋪資料根基
    try {
      writeLintEvent({
        sessionId,
        event: 'blocked',
        ruleCodes: violations.map(v => v.rule),
        violatedWords: extractViolatedWords(violations),
        violationCountInSession: currentCount,
        blockCountInSession: priorBlockCount + 1,
        downgradedToWarning: false,
        aiInstructedToAnnotate: true,
      });
    } catch { /* swallow、不擋主流程 */ }
  } else if (downgradeToWarning) {
    const note = formatDowngradeNotice(priorBlockCount, violations);
    try { process.stderr.write(note + '\n'); } catch { /* ignore */ }
    exitCode = 1;

    // v1.19.11：降警告也寫一筆紀錄
    try {
      writeLintEvent({
        sessionId,
        event: 'downgraded_to_warning',
        ruleCodes: violations.map(v => v.rule),
        violatedWords: extractViolatedWords(violations),
        violationCountInSession: currentCount,
        blockCountInSession: priorBlockCount,
        downgradedToWarning: true,
        aiInstructedToAnnotate: false,
      });
    } catch { /* swallow */ }
  }

  // === Compliance event 路徑（跨 session 統計）===
  const cachedRules = readIronRulesCache();
  const events = buildComplianceEvents(violations, cachedRules, getTierFromRules);
  if (downgradeToWarning) {
    // v1.19.7：每筆違規額外標 repeated_violation_softblock，給 admin 追警告降級事件
    for (const ev of events) {
      if (ev?.details) ev.details.action = 'repeated_violation_softblock';
    }
  }
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

  process.exit(exitCode);
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
 * v1.19.12：合併 transcript 一次讀取、回傳「最後一輪 assistant text + 最近 N 輪 user prompts」。
 *
 * 取代 v1.19.7 的 readLastAssistantText + readRecentUserPrompts（兩次 statSync + readFileSync）。
 * 大 transcript 情境節省一半 I/O。
 *
 * 防呆：
 *   - 檔案大時只讀尾巴 256KB（最後一輪通常在末尾）
 *   - 尾巴讀法可能從某行中間切到 → 丟掉第一行（review B4）
 *
 * user message content 有兩種型態：
 *   1. 字串：{ message: { role: 'user', content: '你好' } }
 *   2. 陣列：{ message: { role: 'user', content: [{ type: 'text', text: '...' }] } }
 * 兩種都支援。
 *
 * @param {string} transcriptPath
 * @param {object} [opts]
 * @param {number} [opts.maxUserTurns=5]
 * @returns {{ lastAssistantText: string|null, recentUserPrompts: string[] }}
 */
function readTranscriptTail(transcriptPath, opts = {}) {
  const maxUserTurns = typeof opts.maxUserTurns === 'number' ? opts.maxUserTurns : 5;
  const empty = { lastAssistantText: null, recentUserPrompts: [] };

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
    return empty;
  }

  let lines = buf.split('\n').filter(Boolean);
  // truncatedHead=true 時第一行可能從某筆 JSON 中間切起 → 丟掉（review B4）
  if (truncatedHead && lines.length > 0) lines = lines.slice(1);

  let lastAssistantText = null;
  const recentUserPrompts = [];

  // 從後往前掃、同時找 last assistant + 最近 N 輪 user
  for (let i = lines.length - 1; i >= 0; i--) {
    // 已抓到 last assistant + 集滿 user prompts → 提早結束
    if (lastAssistantText !== null && recentUserPrompts.length >= maxUserTurns) break;

    const entry = safeParse(lines[i]);
    if (!entry) continue;

    if (entry.type === 'assistant' && lastAssistantText === null) {
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        const texts = content
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text);
        if (texts.length > 0) lastAssistantText = texts.join('\n');
      }
      continue;
    }

    if (entry.type === 'user' && recentUserPrompts.length < maxUserTurns) {
      const content = entry.message?.content;
      if (typeof content === 'string') {
        if (content) recentUserPrompts.push(content);
      } else if (Array.isArray(content)) {
        const texts = content
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text);
        if (texts.length > 0) recentUserPrompts.push(texts.join('\n'));
      }
    }
  }

  return { lastAssistantText, recentUserPrompts };
}

/**
 * 把 lint violations 包成招牌格式（沿用 ownmind-tty-echo.cjs 視覺風格）。
 *
 * v1.19.3：加 MODE 與 session 計數顯示
 * v1.19.7：新增「連續 block 達門檻、降為警告」狀態
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
 *
 * 範例（連續 block 達 3 次後降警告）：
 *   【OwnMind v1.19.7】回話品質 lint ⚠️ 連續擋 3 次降警告（請手動 review）
 */
function formatBanner(violations, getClientVersion, opts = {}) {
  if (!Array.isArray(violations) || violations.length === 0) return null;
  let version;
  try { version = getClientVersion(); } catch { version = '?'; }

  const {
    mode = 'warn',
    modeInvalid = false,
    rawMode = '',
    count = 1,
    threshold = 4,
    blocked = false,
    downgraded = false,
    blockCount = 0,
  } = opts;

  const out = [];
  let header = `【OwnMind v${version}】回話品質 lint`;
  if (downgraded) {
    header += ` ⚠️ 連續擋 ${blockCount} 次降警告（請手動 review、避免死循環）`;
  } else if (blocked) {
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
 * v1.19.7：把 privacy 命中的個資項目壓成一個摘要字串（type×n 形式）
 *
 * v1.19.12 同步說明：labels 跟 shared/privacy-detect.js 的 PRIVACY_TYPE_LABELS
 * 必須保持一致；那邊有 export PRIVACY_TYPE_LABELS 給其他模組共用、未來新增類型時
 * 兩處都要更新。這裡用本地常數而非 dynamic import 是因為函式跑在 module top-level、
 * 不適合 import 失敗時整個 hook 卡住。fallback `labels[t] || t` 仍能保證未知類型
 * 不會破版面。
 */
function formatPrivacySummary(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return '';
  const byType = new Map();
  for (const m of matches) {
    byType.set(m.type, (byType.get(m.type) || 0) + 1);
  }
  const labels = {
    tw_id: '身分證',
    email: '電子信箱',
    phone_tw_mobile: '手機',
  };
  return Array.from(byType.entries())
    .map(([t, n]) => `${labels[t] || t} ${n} 處`)
    .join('、');
}

/**
 * v1.19.7：連續 block 達門檻後降警告時、寫到 stderr 給 user 看的訊息
 * （exit 1 而非 exit 2、所以這段訊息會被 Claude Code 視為 non-blocking 警告
 *  顯示給 user、不會餵回 Claude 當下個 prompt）
 */
function formatDowngradeNotice(priorBlockCount, violations) {
  const ruleList = Array.isArray(violations)
    ? violations.map((v) => v.rule).join(', ')
    : '';
  return [
    `【OwnMind】reply-lint 已連續擋下 ${priorBlockCount} 次、這次降為警告避免死循環。`,
    `仍偵測到：${ruleList}`,
    '請手動檢查 AI 回應、或設定 OWNMIND_REPLY_LINT_MODE=warn 暫時關閉硬擋。',
  ].join('\n');
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
function formatBlockReason(violations, opts = {}) {
  const priorBlockCount = typeof opts.priorBlockCount === 'number' ? opts.priorBlockCount : 0;
  const ruleCodes = violations.map(v => v.rule).join(' + ');

  // v1.19.11 分級顯示：第 2-3 次擋下只給簡短訊息、避免使用者疲勞
  // priorBlockCount=0 是「第 1 次擋」、=1 是「第 2 次擋」、=2 是「第 3 次擋」
  if (priorBlockCount >= 1 && priorBlockCount <= 2) {
    return [
      `↻ 上版違反 ${ruleCodes}、已被指示重寫（本 session 第 ${priorBlockCount + 1} 次擋下）。`,
      '',
      '請開頭加一行標註後再寫新回應：',
      `> ↻ 上版違反 ${ruleCodes}、重新調整。`,
      '',
      '然後直接重寫、不要重新確認問題。',
    ].join('\n');
  }

  // 第 1 次擋下（priorBlockCount=0）或第 4 次以後（不應走到、走 downgrade）→ 完整訊息
  const lines = [];
  lines.push('請重寫你剛才的回應、改善以下品質問題（保持原意、只改語言風格）：');
  lines.push('');

  // v1.19.7 code-review I-5：用 running counter 動態編號、
  // 避免只命中部分規則時編號從 "3." 開始的孤立現象
  let n = 1;
  for (const v of violations) {
    if (v.rule === 'IR-037') {
      const words = (v.detail && Array.isArray(v.detail.mixedWords)) ? v.detail.mixedWords.slice(0, 10) : [];
      lines.push(`${n}. 用白話中文取代以下英文詞（或在第一次出現時用括號附中文解釋）：`);
      if (words.length > 0) {
        lines.push(`   ${words.join(', ')}`);
      }
      lines.push('');
      n += 1;
    } else if (v.rule === 'IR-036') {
      const words = (v.detail && Array.isArray(v.detail.jargon)) ? v.detail.jargon.slice(0, 10) : [];
      lines.push(`${n}. 以下技術詞第一次出現時要附白話說明、用「：解釋」、「（白話）」、「即...」、「也就是...」等格式：`);
      if (words.length > 0) {
        lines.push(`   ${words.join(', ')}`);
      }
      lines.push('');
      n += 1;
    } else if (v.rule === 'privacy_check') {
      // v1.19.7：privacy 命中、不告訴 Claude 命中字串（避免在重寫時把個資再帶一次）
      // v1.19.10：事件名從 'IR-041' 中性化為 'privacy_check'（不綁特定使用者的鐵律編號）
      const matches = (v.detail && Array.isArray(v.detail.matches)) ? v.detail.matches : [];
      const summary = formatPrivacySummary(matches);
      lines.push(`${n}. 回應疑似含使用者隱私（${summary}）。請改寫掉那段或改用代稱（如「[email]」「[手機號碼]」），不要在新回應裡再重複那筆個資。`);
      lines.push('');
      n += 1;
    }
  }

  lines.push('如果上述詞屬於變數名 / 函式名 / 程式碼引用、或上下文已說明過、可保留不改。');

  // v1.19.11 新增：要求 AI 重寫時開頭加自我標註、讓使用者一眼看出「下面是重寫版、原因 XXX」
  // 接受 85% 服從率、AI 沒做不二次擋下（log 保底會記）
  lines.push('');
  lines.push('重寫時必須在開頭加一段引述標註、用以下格式：');
  lines.push('');
  lines.push(`> ⚠️ **上一版違反 ${ruleCodes}、重新調整：**`);
  lines.push('> （簡短說明違規詞或原因）');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('（接著才寫新回應內容）');
  lines.push('');
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
