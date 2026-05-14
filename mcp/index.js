#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// Node 18+ 有 global fetch、不需 node-fetch 套件（v1.17.99 移除依賴）
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, execSync } from 'child_process';
import { logEvent } from "./ownmind-log.js";
import { composeToolResponse } from "./lib/compose-tool-response.js";
import { isNetworkError, readMemoryCache, writeMemoryCache, localSearch, enqueueOperation, readQueue, replayQueue } from './offline.js';
import { appendCompliance } from '../shared/compliance.js';
import {
  detectTriggerFromContext,
  sanitizeErrorMessage,
  pushBounded,
  shouldSkipDuplicate,
} from '../shared/helpers.js';
import { parseStandardMarkdown } from '../src/utils/md-parser.js';
import { captureClientOriginContext, injectOriginSection, validateOriginContext } from '../src/utils/iron-rule-origin-context.js';
import { enrichErrorDetails, errorAliasFields } from './lib/enrich-error.js';

// --- Verifiable rules cache (in-memory, loaded at init) ---
let cachedVerifiableRules = [];

function getCachedVerifiableRules() {
  if (cachedVerifiableRules.length > 0) return cachedVerifiableRules;
  // Fallback: try loading from local file cache
  try {
    const cachePath = path.join(os.homedir(), '.ownmind/cache/iron_rules.json');
    if (fs.existsSync(cachePath)) {
      cachedVerifiableRules = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    }
  } catch { /* ignore */ }
  return cachedVerifiableRules;
}

// --- Lazy-loaded verification engine ---
let evaluateConditions = null;
async function getEvaluateConditions() {
  if (evaluateConditions) return evaluateConditions;
  try {
    const mod = await import(path.join(os.homedir(), '.ownmind/shared/verification.js'));
    evaluateConditions = mod.evaluateConditions;
    return evaluateConditions;
  } catch {
    return null;
  }
}

// --- Cache refresh (called after iron_rule mutations) ---
const CACHE_PATH = path.join(os.homedir(), '.ownmind/cache/iron_rules.json');

async function refreshIronRulesCache() {
  try {
    const tokenParam = currentSyncToken ? `?sync_token=${currentSyncToken}` : '';
    const rules = await callApi('GET', `/api/memory/type/iron_rule${tokenParam}`);
    if (rules.new_token) currentSyncToken = rules.new_token;
    const allRules = Array.isArray(rules) ? rules : (rules.data || []);
    const verifiable = allRules.filter(r => r.metadata?.verification);
    cachedVerifiableRules = verifiable;
    const cacheDir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(verifiable, null, 2));
  } catch { /* silent fail — don't block the caller */ }
}

// --- Session audit helpers ---
function extractSessionChecks(conditions) {
  if (!conditions) return [];
  if (conditions.type === 'recent_event_exists') return [conditions];
  if (conditions.when) return extractSessionChecks(conditions.then);
  if (conditions.checks) return conditions.checks.flatMap(c => extractSessionChecks(c));
  return [];
}

/**
 * Session 結束稽核（L6）
 * 只檢查 recent_event_exists 類型的前置依賴條件。
 * git context 類的檢查（staged_files、commit_message）由 L1 git pre-commit hook 在動作前負責，
 * 此處不重複檢查——如果 commit 已完成代表 L1 通過了（或被 --no-verify 跳過）。
 */
async function auditSession() {
  try {
    if (!sessionStartTime) return { commits_checked: 0, violations_found: 0, violations: [] };
    const since = new Date(sessionStartTime).toISOString();
    const gitLog = execSync(`git log --since="${since}" --format="%H" 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (!gitLog) return { commits_checked: 0, violations_found: 0, violations: [] };

    const commitHashes = gitLog.split('\n').filter(Boolean);
    const rules = getCachedVerifiableRules().filter(r =>
      r.metadata?.verification?.trigger?.includes('commit')
    );

    const evalFn = await getEvaluateConditions();
    if (rules.length === 0 || !evalFn) {
      return { commits_checked: commitHashes.length, violations_found: 0, violations: [] };
    }

    const violations = [];
    for (const hash of commitHashes) {
      for (const rule of rules) {
        const sessionChecks = extractSessionChecks(rule.metadata.verification.conditions);
        if (sessionChecks.length === 0) continue;

        const ctx = { complianceEvents };
        const result = evalFn({ operator: 'AND', checks: sessionChecks }, ctx);
        if (!result.pass) {
          violations.push({
            rule_code: rule.code,
            rule_title: rule.title,
            commit_hash: hash.substring(0, 7),
            failures: result.failures
          });
        }
      }
    }

    // Record violations using shared compliance module
    for (const v of violations) {
      appendCompliance({
        event: v.rule_code,
        action: 'violate',
        rule_code: v.rule_code,
        rule_title: v.rule_title,
        source: 'session_audit',
        commit_hash: v.commit_hash,
        failures: v.failures,
      });
    }

    return {
      commits_checked: commitHashes.length,
      violations_found: violations.length,
      violations
    };
  } catch (e) {
    return { commits_checked: 0, violations_found: 0, violations: [], error: e.message };
  }
}

const pendingUploads = new Map();

// --- Config from env ---
const API_URL = (process.env.OWNMIND_API_URL || "http://localhost:3100").replace(
  /\/$/,
  ""
);
const API_KEY = process.env.OWNMIND_API_KEY || "";

// --- Version & Sync Token (in-memory, per session) ---
const CLIENT_VERSION = (() => {
  try {
    // 統一從根目錄 package.json 讀取版號（單一來源）
    const rootPkg = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(rootPkg, 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
})();
// Which AI tool is hosting this MCP. Cursor / Codex / Antigravity / OpenCode
// users should set OWNMIND_CLIENT_TOOL in their MCP config so heartbeat +
// broadcast targeting identify them correctly. Defaults to claude-code.
const CLIENT_TOOL = process.env.OWNMIND_CLIENT_TOOL || 'claude-code';

let serverVersion = null;
let currentSyncToken = null;

// --- 統一版本標記 ---
const TYPE_MAP = {
  ownmind_init: '記憶載入',
  ownmind_get: {
    profile: '個人偏好', principle: '工作原則', iron_rule: '鐵律提醒',
    coding_standard: '編碼標準', team_standard: '團隊規範', project: '專案記憶',
    env: '環境設定', portfolio: '作品集', session_log: '進度紀錄',
  },
  ownmind_search: '記憶搜尋',
  ownmind_save: '記憶寫入',
  ownmind_update: '記憶寫入',
  ownmind_disable: '記憶寫入',
  ownmind_handoff_create: '建立交接',
  ownmind_handoff_accept: '接受交接',
  ownmind_log_session: '進度紀錄',
  ownmind_get_secret: '密鑰管理',
  ownmind_list_secrets: '密鑰管理',
  ownmind_set_secret: '密鑰管理',
  ownmind_delete_secret: '密鑰管理',
  ownmind_report_compliance: '合規回報',
};

function getVersion() { return serverVersion || CLIENT_VERSION; }
function formatTag(type) { return `【OwnMind v${getVersion()}】${type}`; }

function resolveType(name, args) {
  const entry = TYPE_MAP[name];
  if (!entry) return name;
  if (typeof entry === 'string') return entry;
  // entry is object (ownmind_get)
  return entry[args?.type] || '記憶載入';
}

// --- 技巧提示 ---
const TIPS = [
  '你說「記起來」，我就會把重要經驗寫進記憶，跨平台永久保存',
  '你說「新增鐵律」，我會記錄完整的踩坑背景，確保同樣的錯不再犯',
  '你說「交接給 Codex」，我會整理好工作進度，讓另一個工具無縫接手',
  '你說「我有哪些記憶」，我會列出你所有的偏好、鐵律和專案 context',
  '你說「整理記憶」，我會回顧這次對話，找出值得保存的經驗',
  '你可以問「你學到什麼」「今天有什麼新知識」，讓 AI 回顧並記下學習成果',
  '不管你用 Claude、Cursor 還是 Codex，OwnMind 讓你的 AI 都共享同一份記憶',
  '鐵律不會被刪除，只會被停用並記錄原因，方便日後回顧',
  '每條鐵律都記錄了踩坑的背景，讓你（和 AI）知道為什麼有這條規則',
  '你可以問「最近做了什麼」，我會從工作紀錄中幫你回顧',
  'OwnMind 會在你工作超過 2 小時或 context 超過 50% 時，主動提醒你整理記憶',
  '交接時雙方都會看到摘要，確保沒有資訊遺漏',
  '你的記憶可以隨時匯出成 markdown，資料永遠屬於你',
  '你說「不要遵守這條」，我會先問你原因，然後停用但不刪除，留下完整紀錄',
  '你可以搜尋記憶，例如「跟部署有關的鐵律」，我會用語意搜尋幫你找',
  'OwnMind 會自動記錄你使用的機器、工具和 AI 模型，方便追溯',
  '換一台電腦？只要安裝 OwnMind，所有記憶立刻同步，不用重新教 AI',
  '你可以問「ring 專案還有什麼沒做」，我會從專案記憶中回答',
  '鐵律有編號（IR-001），方便你直接引用：「參考 IR-003」',
  '每次交接都會記錄來源工具和模型，你可以追溯是哪個 AI 做的決策',
  '你可以隨時問「這條鐵律是怎麼來的」，我會告訴你當初踩坑的完整背景',
  'OwnMind 支援密鑰管理，你的 API key 和密碼可以安全儲存，需要時才取用',
  '你可以說「更新 ring 的進度」，我會幫你更新專案狀態和待辦事項',
  '即使在線上 AI（claude.ai、ChatGPT）也能匯出記憶來使用',
  '記憶分短期和長期：session log 會自動壓縮，鐵律和決策永久保留',
  '你可以問「哪些鐵律被停用了」，回顧過去的決策變更',
  'OwnMind 會持續進化 — AI 會主動建議改進你的工作流程和規則',
  '你說「這個專案做完了」，我會把它歸檔到作品集，記錄技術選型和心得',
];
let lastTipIndex = -1;
function getRandomTip() {
  let idx;
  do { idx = Math.floor(Math.random() * TIPS.length); } while (idx === lastTipIndex && TIPS.length > 1);
  lastTipIndex = idx;
  return TIPS[idx];
}

// --- Session tracking (for emergency shutdown log) ---
// v1.18.4: fallback 從 'unknown' 改 'claude-code'，跟 mcp/ownmind-log.js 同步。
// OWNMIND_TOOL 仍優先生效，向後相容。
const TOOL_NAME = process.env.OWNMIND_TOOL
  || process.env.OWNMIND_CLIENT_TOOL
  || 'claude-code';
let sessionStartTime = null;
const toolCallCounts = {};
let complianceEvents = [];
const COMPLIANCE_EVENTS_MAX = 500;
const AUTO_COMPLY_DEDUP_TTL_MS = 60_000;
let sessionLogged = false;
// v1.17.37: 自動偵測 project 名稱（IR-027「邏輯才有效」— 不要叫 user 每次手動跟 AI 講）
// CLAUDE_PROJECT_DIR 是 Claude Code 在啟動 MCP 時帶進來的專案根目錄；
// 若 user 沒在 git repo 或別的工具就用 cwd basename 當 fallback。
const AUTO_PROJECT = (() => {
  try {
    const dir = process.env.CLAUDE_PROJECT_DIR
      || process.env.OWNMIND_PROJECT_DIR
      || process.cwd();
    if (!dir || dir === '/' || dir === os.homedir()) return null;
    return path.basename(dir);
  } catch { return null; }
})();

// --- v1.17.0 P4: Broadcast fetch + render ---
// 不 block tool call、失敗靜默、逾時 2s
async function fetchBroadcastsSafely() {
  if (!API_KEY) return '';
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 2000);
    // v1.17.18: 用 package.json 讀出的 CLIENT_VERSION（process.env.OWNMIND_VERSION
    // 從未被設定，導致 broadcast inject 永遠不帶版本，semver filter 跳過）
    const clientVersion = CLIENT_VERSION || process.env.OWNMIND_VERSION || '';
    const res = await fetch(`${API_URL}/api/broadcast/inject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        ...(clientVersion ? { 'x-ownmind-version': clientVersion } : {})
      },
      body: JSON.stringify({ tool: TOOL_NAME, client_version: clientVersion || null }),
      signal: controller.signal
    }).finally(() => clearTimeout(to));
    if (!res.ok) return '';
    const data = await res.json();
    const bcList = Array.isArray(data.broadcasts) ? data.broadcasts : [];
    if (bcList.length === 0) return '';
    return renderBroadcasts(bcList);
  } catch {
    return '';  // 網路異常 / timeout → 靜默
  }
}

function renderBroadcasts(broadcasts) {
  const lines = ['📢 OwnMind 系統通知'];
  for (const bc of broadcasts.slice(0, 3)) {
    const sev = String(bc.severity || 'info').toUpperCase();
    lines.push(`[${sev}] ${String(bc.title || '').replace(/\n/g, ' ')}`);
    const body = String(bc.body || '').split('\n').slice(0, 5).join(' ').slice(0, 400);
    if (body) lines.push(body);
    if (bc.cta_text) {
      const hint = bc.cta_action === 'upgrade_ownmind' ? '讓 AI 幫你升級' : '';
      lines.push(`👉 可說「${bc.cta_text}」${hint}`);
    }
    if (bc.allow_snooze) {
      lines.push(`（不想現在處理？可說「暫緩升級」延後 ${bc.snooze_hours || 24} 小時）`);
    }
    lines.push('');
  }
  if (broadcasts.length > 3) {
    lines.push(`（另有 ${broadcasts.length - 3} 則廣播未顯示）`);
  }
  lines.push('---');
  return lines.join('\n');
}

// --- Helper ---
// Send MCP heartbeat so dashboard can mark this user as "installed" even
// without the scheduled scanner. Fire-and-forget — never block init.
//
// Crash-loop protection: a misconfigured MCP that starts → crashes → restarts
// in a fast loop would otherwise spam heartbeats at high rate. The module-
// scope `heartbeatSent` flag caps each MCP process at exactly one heartbeat,
// regardless of how many call sites trigger it (startup + ownmind_init).
// The flag is set BEFORE the await so parallel/rapid calls during the in-
// flight POST also short-circuit, instead of racing multiple POSTs.
let heartbeatSent = false;
async function sendMcpHeartbeat() {
  if (heartbeatSent) return;
  heartbeatSent = true;
  try {
    await callApi('POST', '/api/usage/events', {
      events: [],
      heartbeat: {
        tool: CLIENT_TOOL,
        scanner_version: CLIENT_VERSION,
        machine: os.hostname(),
        os: os.platform(),
      },
    });
  } catch { /* silent fail — heartbeat is best-effort */ }
}

async function callApi(method, path, body) {
  const url = `${API_URL}${path}`;
  const headers = {
    "Content-Type": "application/json",
    "x-ownmind-tool": CLIENT_TOOL,
  };
  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  const opts = { method, headers };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null
        ? data.error || data.message || JSON.stringify(data)
        : text;
    throw new Error(`API ${res.status}: ${msg}`);
  }

  return data;
}

// --- Tool definitions ---
const TOOLS = [
  {
    name: "ownmind_init",
    description:
      "載入初始記憶（instructions、profile、principles、iron_rules、iron_rules_digest、active_handoff）。每次新對話開始時必須呼叫。iron_rules_digest 為精簡摘要，須立即內化為工作準則。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "ownmind_get",
    description: "依類型取得記憶列表。",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["profile", "principle", "iron_rule", "coding_standard", "team_standard", "project", "portfolio", "env", "session_log"], description: "記憶類型" },
      },
      required: ["type"],
    },
  },
  {
    name: "ownmind_search",
    description: "以關鍵字搜尋記憶。回傳符合條件的記憶列表。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜尋關鍵字" },
      },
      required: ["query"],
    },
  },
  {
    name: "ownmind_save",
    description: "儲存一筆新記憶。可指定類型、標題、內容，以及選填的 code、tags、metadata。寫 iron_rule 時 AI 應主動帶 origin_event / user_quote 描述「為什麼當時建立這條鐵律」、不知道時就寫「user 直接下令」。",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["profile", "principle", "iron_rule", "coding_standard", "team_standard", "project", "portfolio", "env", "session_log"], description: "記憶類型" },
        title: { type: "string", description: "記憶標題" },
        content: { type: "string", description: "記憶內容" },
        code: { type: "string", description: "相關程式碼（選填）" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "標籤列表（選填）。iron_rule 可加 trigger: 前綴標記觸發時機，例如 trigger:git、trigger:commit、trigger:deploy、trigger:delete",
        },
        metadata: {
          type: "object",
          description: "額外的 metadata（選填）",
        },
        // v1.18.2: iron_rule 專用 — AI 主動補時空背景
        origin_event: {
          type: "string",
          description: "（iron_rule 用）AI 從對話脈絡推斷的事件描述。例：『升級助手測試發現 IR-037 套錯場景』。不知道時寫『user 直接下令建立、無工作脈絡』。",
        },
        user_quote: {
          type: "string",
          description: "（iron_rule 用）user 觸發鐵律建立的原話（選填）。例：『我覺得鐵律應該記時空背景』。",
        },
        origin_confidence: {
          type: "string",
          enum: ["high", "user_direct", "unknown"],
          description: "（iron_rule 用）背景信心：high=從對話脈絡推斷可信、user_direct=user 直接下令、unknown=無法判斷。預設 unknown。",
        },
        related_rules: {
          type: "array",
          items: { type: "string" },
          description: "（iron_rule 用）相關鐵律 code（選填）。例：['IR-037', 'IR-007']",
        },
      },
      required: ["type", "title", "content"],
    },
  },
  {
    name: "ownmind_update",
    description: "更新一筆既有記憶的內容。需提供記憶 ID 和更新原因（update_reason），舊內容會自動保存到歷史紀錄。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "記憶 ID" },
        content: { type: "string", description: "更新後的內容（選填，不填則保留原內容）" },
        update_reason: { type: "string", description: "更新原因（必填）" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "更新後的標籤（選填）。iron_rule 可用 trigger: 前綴，例如 trigger:commit、trigger:deploy",
        },
        metadata: {
          type: "object",
          description: "更新後的 metadata（選填）",
        },
      },
      required: ["id", "update_reason"],
    },
  },
  {
    name: "ownmind_disable",
    description: "停用一筆記憶（例如鐵律）。需提供停用原因。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "記憶 ID" },
        reason: { type: "string", description: "停用原因" },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "ownmind_handoff_create",
    description:
      "建立一筆交接紀錄，讓另一個工具或 session 可以接手未完成的工作。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "專案名稱" },
        content: { type: "string", description: "交接內容" },
        from_tool: { type: "string", description: "來源工具名稱（選填）" },
        from_model: { type: "string", description: "來源模型名稱（選填）" },
        from_machine: { type: "string", description: "來源機器名稱（選填）" },
      },
      required: ["project", "content"],
    },
  },
  {
    name: "ownmind_handoff_accept",
    description: "接受一筆待處理的交接紀錄。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "交接紀錄 ID" },
        accepted_by: { type: "string", description: "接受者名稱" },
      },
      required: ["id", "accepted_by"],
    },
  },
  {
    name: "ownmind_log_session",
    description: "記錄一次工作 session 的摘要與情境。對話結束前必須呼叫，不需使用者確認。",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Session 摘要（1-2 句描述做了什麼）" },
        tool: { type: "string", description: "使用的工具（如 claude-code, cursor, codex）" },
        model: { type: "string", description: "使用的模型（如 claude-opus-4-6, gpt-5）" },
        machine: { type: "string", description: "執行的機器（選填）" },
        details: {
          type: "object",
          description: "結構化情境報告",
          properties: {
            project: { type: "string", description: "主要操作的專案名稱" },
            duration_turns: { type: "number", description: "對話輪數" },
            actions: { type: "array", items: { type: "string" }, description: "執行的動作類型（如 code_edit, git_commit, deploy, debug, research）" },
            rules_triggered: { type: "array", items: { type: "string" }, description: "觸發的鐵律編號（如 IR-001）" },
            rules_complied: { type: "array", items: { type: "string" }, description: "遵守的鐵律編號" },
            rules_skipped: { type: "array", items: { type: "string" }, description: "跳過的鐵律編號" },
            friction_points: { type: "string", description: "使用者遇到的痛點或不順暢的地方" },
            suggestions: { type: "string", description: "AI 觀察到可以改善 OwnMind 的建議" },
          },
        },
      },
      required: ["summary", "tool", "model"],
    },
  },
  {
    name: "ownmind_get_secret",
    description: "取得一筆 secret 的值。需提供 key。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Secret 的 key" },
      },
      required: ["key"],
    },
  },
  {
    name: "ownmind_list_secrets",
    description: "列出所有已儲存的 secret key（不含值）。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "ownmind_set_secret",
    description: "儲存或更新一筆 secret（upsert：key 已存在則覆蓋值）。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Secret 的 key" },
        value: { type: "string", description: "Secret 的值" },
        description: { type: "string", description: "說明（選填）" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "ownmind_delete_secret",
    description: "永久刪除一筆 secret。注意：刪除不可復原，無法回復。建議刪除前先用 ownmind_list_secrets 確認 key、避免誤刪。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "要刪除的 Secret key" },
      },
      required: ["key"],
    },
  },
  {
    name: "ownmind_report_compliance",
    description: "回報鐵律遵守狀況。當鐵律被觸發時，AI 必須呼叫此 tool 回報是否遵守。action: 'comply'（遵守）、'skip'（使用者要求跳過）、'violate'（違反）。",
    inputSchema: {
      type: "object",
      properties: {
        rule_title: { type: "string", description: "鐵律標題" },
        rule_code: { type: "string", description: "鐵律編號（如 IR-001）" },
        action: { type: "string", enum: ["comply", "skip", "violate"], description: "comply=遵守, skip=使用者要求跳過, violate=違反" },
        context: { type: "string", description: "觸發的操作情境（選填）" },
      },
      required: ["rule_title", "action"],
    },
  },
  {
    name: "ownmind_upload_standard",
    description: "讀取本地 Markdown 規範檔案並進行切分預覽。會回傳切分後的標題與變動統計。",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Markdown 檔案的絕對路徑" },
        title: { type: "string", description: "規範標題（選填，預設為檔名）" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "ownmind_confirm_upload",
    description: "確認並正式提交規範上傳。需提供 upload_standard 回傳的 session_id。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "上傳階段回傳的 session_id" },
      },
      required: ["session_id"],
    },
  },
];

// --- Tool handlers ---
async function handleTool(name, args) {
  // Session tracking
  if (!sessionStartTime) sessionStartTime = Date.now();
  toolCallCounts[name] = (toolCallCounts[name] || 0) + 1;

  switch (name) {
    case "ownmind_init": {
      // Reset session state（MCP 進程可能跨 session 存活）
      complianceEvents = [];
      let data;
      try {
        data = await callApi("GET", `/api/memory/init?client_version=${CLIENT_VERSION}&compact=true`);
      } catch (initErr) {
        if (isNetworkError(initErr)) {
          const cache = readMemoryCache();
          if (cache) {
            logEvent('init', { status: 'offline', details: { saved_at: cache.saved_at } });
            return {
              _offline: true,
              _offline_notice: `【OwnMind 離線模式】無法連線 server，資料來自本地 cache（${cache.saved_at}），可能不是最新`,
              iron_rules: cache.data.iron_rule || [],
              principles: cache.data.principle || [],
              profile: (cache.data.profile || [])[0] || null,
              coding_standards: cache.data.coding_standard || [],
              team_standards: cache.data.team_standard || [],
              projects: cache.data.project || [],
              envs: cache.data.env || [],
              portfolios: cache.data.portfolio || [],
            };
          }
        }
        throw initErr;
      }
      if (data.sync_token) {
        currentSyncToken = data.sync_token;
      }
      if (data.server_version) serverVersion = data.server_version;
      if (data.upgrade_action?.required) {
        data._upgrade_notice = `⚠️ ${data.upgrade_action.message}\n執行：${data.upgrade_action.command}`;
      }
      data._client_version = CLIENT_VERSION;
      // Enforcement Alerts 已由 server 端嵌入 iron_rules_digest，不需 client 重複格式化
      // E4: Sync verifiable rules to local cache
      try {
        const verifiableRules = (data.iron_rules || []).filter(r => r.metadata?.verification);
        cachedVerifiableRules = verifiableRules;
        const cachePath = path.join(os.homedir(), '.ownmind/cache/iron_rules.json');
        const cacheDir = path.dirname(cachePath);
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(verifiableRules, null, 2));
      } catch { /* silent fail */ }

      // Write full memory cache for offline fallback
      try {
        writeMemoryCache({
          saved_at: new Date().toISOString(),
          sync_token: data.sync_token || null,
          data: {
            profile: data.profile ? [data.profile] : [],
            principle: data.principles || [],
            iron_rule: data.iron_rules || [],
            coding_standard: data.coding_standards || [],
            team_standard: data.team_standards || [],
            project: data.projects || [],
            env: data.envs || [],
            portfolio: data.portfolios || [],
          }
        });
      } catch { /* silent fail */ }

      // Queue replay: send any queued operations now that server is online
      const replayResult = await replayQueue(callApi, currentSyncToken);
      if (replayResult.message) data._queue_replay = replayResult.message;

      // Eagerly load verification engine
      getEvaluateConditions().catch(() => {});

      logEvent('init', { status: 'ok', details: { rules: data.iron_rules?.length || 0, profile: !!data.profile, handoff: !!data.active_handoff, version: data.server_version } });
      sendMcpHeartbeat();
      if (data._onboarding?.is_new_user) {
        data._onboarding_instruction =
          `【OwnMind 新用戶初始化】偵測到這是全新帳號，尚無任何記憶。` +
          `使用工具：${data._onboarding.detected_tool}（已自動記錄）。` +
          `請立即向使用者提問：「${data._onboarding.question}」` +
          `收到回答後，呼叫 ownmind_save 建立 type=profile 記憶，` +
          `content 包含：名字、工作、使用工具。完成後告知用戶記憶已建立。`;
      }
      return data;
    }

    case "ownmind_get": {
      const tokenParam = currentSyncToken ? `?sync_token=${currentSyncToken}` : '';
      // v1.17.13 Michelle case: session_log 存 session_logs 獨立表而非 memories，
      // 轉呼 /api/session/recent 讓使用者寫 (ownmind_log_session) 讀 (ownmind_get) 一致
      if (args.type === 'session_log') {
        try {
          const rows = await callApi("GET", `/api/session/recent?days=30&include_compressed=true`);
          logEvent('memory_get', { type: args.type, from_session_logs: true });
          return { data: Array.isArray(rows) ? rows : [] };
        } catch (err) {
          if (isNetworkError(err)) {
            logEvent('memory_get', { type: args.type, offline: true });
            return {
              data: [],
              _offline: true,
              _offline_notice: '【OwnMind 離線模式】session_log 需要連線查詢 session_logs 表',
            };
          }
          throw err;
        }
      }
      try {
        const data = await callApi("GET", `/api/memory/type/${encodeURIComponent(args.type)}${tokenParam}`);
        if (data.new_token) currentSyncToken = data.new_token;
        logEvent('memory_get', { type: args.type });
        return data;
      } catch (err) {
        if (isNetworkError(err)) {
          const cache = readMemoryCache();
          const items = cache?.data?.[args.type] || [];
          logEvent('memory_get', { type: args.type, offline: true });
          return {
            data: items,
            _offline: true,
            _offline_notice: `【OwnMind 離線模式】資料來自本地 cache（${cache?.saved_at || '未知'}）`,
          };
        }
        throw err;
      }
    }

    case "ownmind_search": {
      const searchTokenParam = currentSyncToken ? `&sync_token=${currentSyncToken}` : '';
      try {
        // v1.17.13 同時搜 memories + session_logs 合併（Michelle case）
        const [memoryRows, sessionRows] = await Promise.all([
          callApi("GET", `/api/memory/search?q=${encodeURIComponent(args.query)}${searchTokenParam}`)
            .catch(() => []),
          callApi("GET", `/api/session/recent?days=90&include_compressed=true&q=${encodeURIComponent(args.query)}`)
            .catch(() => []),
        ]);
        const memoryData = Array.isArray(memoryRows) ? memoryRows : (memoryRows?.data || []);
        const sessionData = Array.isArray(sessionRows) ? sessionRows : [];
        const sessionAsMemory = sessionData.map((s) => ({
          id: s.id,
          type: 'session_log',
          title: (s.summary || '').slice(0, 80),
          content: s.summary,
          details: s.details,
          tool: s.tool,
          model: s.model,
          created_at: s.created_at,
          _source: 'session_logs',
        }));
        const merged = [...memoryData, ...sessionAsMemory];
        if (memoryRows?.new_token) currentSyncToken = memoryRows.new_token;
        logEvent('memory_search', { query: args.query, memory_hits: memoryData.length, session_hits: sessionData.length });
        return { data: merged, memory_hits: memoryData.length, session_hits: sessionData.length };
      } catch (err) {
        if (isNetworkError(err)) {
          const cache = readMemoryCache();
          const results = localSearch(cache, args.query);
          logEvent('memory_search', { query: args.query, offline: true });
          return {
            data: results,
            _offline: true,
            _offline_notice: `【OwnMind 離線模式】本地關鍵字搜尋（${results.length} 筆），不支援語意搜尋`,
          };
        }
        throw err;
      }
    }

    case "ownmind_save": {
      const body = {
        type: args.type,
        title: args.title,
        content: args.content,
        sync_token: currentSyncToken,
      };
      if (args.code !== undefined) body.code = args.code;
      if (args.tags !== undefined) body.tags = args.tags;
      if (args.metadata !== undefined) body.metadata = args.metadata;

      // v1.18.2: iron_rule 自動 capture + 注入 origin_context (時空背景)
      // - 技術部分 (cwd/git_branch/captured_at) 由 client 自動帶
      // - 事件描述 (event/user_quote/confidence) 由 AI 主動帶 (透過 args.origin_event 等)
      // - 沒帶 → confidence='unknown'、寫進 metadata 但不擋
      // - body 自動 inject「## 起源」段落 (給未來 AI 看脈絡)
      if (args.type === 'iron_rule') {
        const oc = captureClientOriginContext({
          confidence: args.origin_confidence || (args.origin_event ? 'high' : 'unknown'),
          event: args.origin_event,
          userQuote: args.user_quote,
          relatedRules: args.related_rules,
        });
        // git branch (best effort、git 沒裝就 skip)
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', {
            encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
          if (branch) oc.git_branch = branch;
        } catch { /* not a git repo */ }

        // 寫進 metadata
        body.metadata = body.metadata || {};
        body.metadata.origin_context = oc;

        // 注入 body「## 起源」段落 (render from oc)
        body.content = injectOriginSection(body.content, oc);
      }

      try {
        const data = await callApi("POST", "/api/memory", body);
        if (data.sync_token) currentSyncToken = data.sync_token;
        logEvent('memory_save', { type: args.type, title: args.title });
        // Refresh cache if iron_rule was saved
        if (args.type === 'iron_rule') {
          refreshIronRulesCache().catch(() => {});
        }
        return data;
      } catch (err) {
        if (isNetworkError(err)) {
          const queueLen = readQueue().length;
          enqueueOperation({ method: 'POST', path: '/api/memory', body });
          logEvent('memory_save', { type: args.type, title: args.title, queued: true });
          return { _queued: true, _queue_notice: `【OwnMind 離線模式】操作已排入佇列，上線後自動送出（目前佇列 ${queueLen + 1} 筆）` };
        }
        throw err;
      }
    }

    case "ownmind_update": {
      const body = { update_reason: args.update_reason, sync_token: currentSyncToken };
      if (args.content !== undefined) body.content = args.content;
      if (args.tags !== undefined) body.tags = args.tags;
      if (args.metadata !== undefined) body.metadata = args.metadata;
      try {
        const data = await callApi("PUT", `/api/memory/${args.id}`, body);
        if (data.sync_token) currentSyncToken = data.sync_token;
        logEvent('memory_update', { id: args.id, reason: args.update_reason });
        // Refresh cache if iron_rule was updated
        if (data.type === 'iron_rule' || data.memory?.type === 'iron_rule') {
          refreshIronRulesCache().catch(() => {});
        }
        return data;
      } catch (err) {
        if (isNetworkError(err)) {
          const queueLen = readQueue().length;
          enqueueOperation({ method: 'PUT', path: `/api/memory/${args.id}`, body });
          logEvent('memory_update', { id: args.id, queued: true });
          return { _queued: true, _queue_notice: `【OwnMind 離線模式】操作已排入佇列，上線後自動送出（目前佇列 ${queueLen + 1} 筆）` };
        }
        throw err;
      }
    }

    case "ownmind_disable": {
      const disableBody = { reason: args.reason, sync_token: currentSyncToken };
      try {
        const data = await callApi("PUT", `/api/memory/${args.id}/disable`, disableBody);
        if (data.sync_token) currentSyncToken = data.sync_token;
        logEvent('memory_disable', { id: args.id, reason: args.reason });
        // Refresh cache if iron_rule was disabled
        if (data.type === 'iron_rule' || data.memory?.type === 'iron_rule') {
          refreshIronRulesCache().catch(() => {});
        }
        return data;
      } catch (err) {
        if (isNetworkError(err)) {
          const queueLen = readQueue().length;
          enqueueOperation({ method: 'PUT', path: `/api/memory/${args.id}/disable`, body: disableBody });
          logEvent('memory_disable', { id: args.id, queued: true });
          return { _queued: true, _queue_notice: `【OwnMind 離線模式】操作已排入佇列，上線後自動送出（目前佇列 ${queueLen + 1} 筆）` };
        }
        throw err;
      }
    }

    case "ownmind_handoff_create": {
      const body = { project: args.project, content: args.content, sync_token: currentSyncToken };
      if (args.from_tool !== undefined) body.from_tool = args.from_tool;
      if (args.from_model !== undefined) body.from_model = args.from_model;
      if (args.from_machine !== undefined) body.from_machine = args.from_machine;
      const data = await callApi("POST", "/api/handoff", body);
      if (data.sync_token) currentSyncToken = data.sync_token;
      logEvent('handoff_create', { project: args.project });
      return data;
    }

    case "ownmind_handoff_accept": {
      const data = await callApi("PUT", `/api/handoff/${args.id}/accept`, {
        accepted_by: args.accepted_by,
        sync_token: currentSyncToken,
      });
      if (data.sync_token) currentSyncToken = data.sync_token;
      logEvent('handoff_accept', { id: args.id, accepted_by: args.accepted_by });
      return data;
    }

    case "ownmind_log_session": {
      const body = { summary: args.summary, sync_token: currentSyncToken };
      if (args.tool !== undefined) body.tool = args.tool;
      if (args.model !== undefined) body.model = args.model;
      if (args.machine !== undefined) body.machine = args.machine;
      if (args.details !== undefined) body.details = args.details;

      // E5: Session audit (L6) — check commits against compliance events
      try {
        const auditResult = await auditSession();
        if (auditResult.violations_found > 0 || auditResult.commits_checked > 0) {
          if (!body.details) body.details = {};
          body.details.session_audit = auditResult;
        }
      } catch { /* audit failure should not block session log */ }

      const data = await callApi("POST", "/api/session", body);
      if (data.sync_token) currentSyncToken = data.sync_token;
      sessionLogged = true;
      logEvent('session_log', { summary: args.summary });
      return data;
    }

    case "ownmind_get_secret":
      return await callApi("GET", `/api/secret/${encodeURIComponent(args.key)}`);

    case "ownmind_list_secrets":
      return await callApi("GET", "/api/secret");

    case "ownmind_set_secret": {
      const body = { key: args.key, value: args.value };
      if (args.description !== undefined) body.description = args.description;
      return await callApi("POST", "/api/secret", body);
    }

    case "ownmind_delete_secret": {
      // v1.17.91: 永久刪除一筆 secret。server 端會寫 activity_log audit
      // （IR-002 不洩漏 value、只記 key 跟動作）
      return await callApi("DELETE", `/api/secret/${encodeURIComponent(args.key)}`);
    }

    case "ownmind_report_compliance": {
      pushBounded(complianceEvents, { rule_title: args.rule_title, action: args.action, rule_code: args.rule_code || '', ts: new Date().toISOString() }, COMPLIANCE_EVENTS_MAX);
      logEvent('iron_rule_compliance', {
        rule_title: args.rule_title,
        rule_code: args.rule_code || null,
        action: args.action,
        context: args.context || null,
      });

      // E1: Write to compliance JSONL using shared module
      appendCompliance({
        event: args.rule_code || args.rule_title,
        action: args.action,
        rule_code: args.rule_code || '',
        rule_title: args.rule_title,
        source: 'mcp',
        session_id: sessionStartTime ? String(sessionStartTime) : '',
      });

      // E3: Auto-verify on trigger detection
      const trigger = detectTriggerFromContext(args.context);
      if (trigger) {
        try {
          const evalFn = await getEvaluateConditions();
          if (evalFn) {
            const rules = getCachedVerifiableRules().filter(r =>
              r.metadata?.verification?.trigger?.includes(trigger)
            );
            const failures = [];
            for (const rule of rules) {
              const conditions = rule.metadata?.verification?.conditions;
              if (!conditions) continue;
              const sessionChecks = extractSessionChecks(conditions);
              if (sessionChecks.length === 0) continue;
              const ctx = { complianceEvents };
              const result = evalFn({ operator: 'AND', checks: sessionChecks }, ctx);
              if (!result.pass) {
                const shouldBlock = rule.metadata?.verification?.block_on_fail;
                failures.push({
                  rule_code: rule.code,
                  rule_title: rule.title,
                  block: !!shouldBlock,
                  failures: result.failures
                });
              }
            }
            const blockingFailures = failures.filter(f => f.block);
            if (blockingFailures.length > 0) {
              return {
                status: 'blocked',
                action: args.action,
                rule: args.rule_title,
                verification_failures: blockingFailures,
                message: `Blocked by verification: ${blockingFailures.map(f => f.rule_code || f.rule_title).join(', ')}`
              };
            }
          }
        } catch { /* verification engine not available, skip */ }
      }

      return { status: 'ok', action: args.action, rule: args.rule_title };
    }

    case "ownmind_upload_standard": {
      const { file_path, title } = args;
      if (!fs.existsSync(file_path)) {
        throw new Error(`找不到檔案：${file_path}`);
      }
      const rawContent = fs.readFileSync(file_path, 'utf8');
      const standardTitle = title || path.basename(file_path, '.md');
      const chunks = parseStandardMarkdown(rawContent, 3);
      
      const sessionId = Math.random().toString(36).substring(2, 10);
      pendingUploads.set(sessionId, { 
        parent_title: standardTitle, 
        chunks, 
        created_at: Date.now() 
      });
      
      return {
        session_id: sessionId,
        parent_title: standardTitle,
        chunk_count: chunks.length,
        preview: chunks.map(c => ({ title: c.title, level: c.level })),
        notice: "【OwnMind】預覽已生成。請檢閱區塊內容，並分析是否有任一區塊應存為鐵律 (iron_rule)。若沒問題，請呼叫 ownmind_confirm_upload 並帶入 session_id。"
      };
    }

    case "ownmind_confirm_upload": {
      const pending = pendingUploads.get(args.session_id);
      if (!pending) {
        throw new Error(`找不到暫存的上傳工作 (Session ID: ${args.session_id})`);
      }
      
      // TTL 檢查 (10 分鐘)
      if (Date.now() - pending.created_at > 10 * 60 * 1000) {
        pendingUploads.delete(args.session_id);
        throw new Error(`上傳工作已過期 (Session ID: ${args.session_id})。請重新呼叫 ownmind_upload_standard。`);
      }
      
      const body = {
        parent_title: pending.parent_title,
        chunks: pending.chunks,
        sync_token: currentSyncToken,
      };
      
      const data = await callApi("POST", "/api/memory/batch-sync-standard", body);
      if (data.sync_token) currentSyncToken = data.sync_token;
      
      pendingUploads.delete(args.session_id);
      logEvent('memory_sync_standard', { title: pending.parent_title, stats: data.stats });
      
      return data;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- Server setup ---
const server = new Server(
  { name: "ownmind-mcp", version: CLIENT_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// v1.17.41 — Codex round 4 review 修補：
// 之前 v1.17.40 把 system 觀測寫成 action='comply' 是自欺，誠信問題。
// 改成 action='observed_trigger'：誠實標示「系統觀測到 tool 被呼叫」，
// 不假裝「已驗證遵守鐵律」。
// 同時移除 handoff_create → IR-008/009/024 的過度推論（commit 規則該靠 git hook）。
//
// 三層語意：
//   - observed_trigger（系統自動）= 系統看到觸發點，不證明遵守
//   - comply（AI 主動 ownmind_report_compliance）= AI 聲稱遵守
//   - verified_comply（未來預留）= git hook 等程式驗證過
//
// In-memory dedup：滑動時間窗（60s 內同 rule + tool 不重複算）
// v1.17.59 改：原本用「分鐘 bucket」當 key，:59 → :00 邊界連打會被分到不同 bucket、
// 兩次都通過。改成 Map<key, first_seen_ts> + sliding window，避免邊界 bug。
const _autoComplyDedup = new Map();
function _dedupKey(name, ruleCode) {
  return `${ruleCode}|${name}`;
}

async function autoComplyForToolCall(name, args, result) {
  const triggers = [];
  // ownmind_disable rule → IR-006「學到東西必須全層同步更新」
  // 觀測到「鐵律記憶被停用」這個 trigger，但不能證明 OpenSpec/skill 等其他層也同步
  if (name === 'ownmind_disable' &&
      (result?.type === 'iron_rule' || result?.memory?.type === 'iron_rule')) {
    triggers.push({
      rule_code: 'IR-006',
      rule_title: '學到東西必須全層同步更新',
      action: 'observed_trigger',
      context: `停用鐵律 id=${args.id}（系統觀測到觸發點，未驗證全層同步）`,
    });
  }
  // ownmind_save / ownmind_update with type=iron_rule
  if ((name === 'ownmind_save' && args.type === 'iron_rule') ||
      (name === 'ownmind_update' &&
       (result?.type === 'iron_rule' || result?.memory?.type === 'iron_rule'))) {
    triggers.push({
      rule_code: 'IR-006',
      rule_title: '學到東西必須全層同步更新',
      action: 'observed_trigger',
      context: `${name === 'ownmind_save' ? '新增' : '更新'}鐵律 id=${args.id || result?.id || '?'}（系統觀測，未驗證）`,
    });
  }
  // 移除 handoff_create → IR-008/009/024 的過度推論
  // Codex review：建立交接不能證明 commit 守了那些鐵律
  // 那些是 git hook 該抓的，不是 MCP handoff handler 自動聲稱

  for (const trig of triggers) {
    // 去重：同一鐵律 60s 內同一 tool 只算一次（滑動視窗）
    const key = _dedupKey(name, trig.rule_code);
    if (shouldSkipDuplicate(_autoComplyDedup, key, AUTO_COMPLY_DEDUP_TTL_MS)) continue;

    // logEvent 失敗會自己寫 stderr，這裡額外 try/catch 不吞錯誤訊息
    try {
      logEvent('iron_rule_compliance', {
        rule_code: trig.rule_code,
        rule_title: trig.rule_title,
        action: trig.action,
        context: trig.context,
        source: 'system_auto',
        tool_call: name,
      });
    } catch (e) {
      console.error('[autoComply] logEvent failed:', sanitizeErrorMessage(e?.message));
    }
    try {
      // 對齊 manual ownmind_report_compliance path（mcp/index.js:907）
      appendCompliance({
        event: trig.rule_code,
        action: trig.action,
        rule_code: trig.rule_code,
        rule_title: trig.rule_title,
        source: 'system_auto',
        tool_call: name,
        context: trig.context,
      });
    } catch (e) {
      console.error('[autoComply] appendCompliance failed:', sanitizeErrorMessage(e?.message));
    }
    pushBounded(complianceEvents, {
      ...trig,
      source: 'system_auto',
      ts: new Date().toISOString(),
    }, COMPLIANCE_EVENTS_MAX);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleTool(name, args || {});
    // v1.17.40: 自動代呼 iron_rule_compliance（不阻擋主流程）
    // v1.17.41: 不再 silent — 錯誤寫 stderr 至少能 debug
    autoComplyForToolCall(name, args || {}, result).catch((e) => {
      console.error('[autoComply] failed:', sanitizeErrorMessage(e?.message));
    });
    const typeName = resolveType(name, args);
    const tag = formatTag(typeName);
    const body = typeof result === "string" ? result : JSON.stringify(result, null, 2);

    // v1.17.0 P4：每次 ownmind_* tool call 後 ping server 要廣播注入
    // 不 block 主流程：fetch 失敗 → 靜默 skip（不該因廣播掛掉 tool）
    const broadcastText = await fetchBroadcastsSafely();

    // v1.17.69：合併成單一 text part。v1.17.0~v1.17.68 用 4 個獨立 part（broadcast /
    // 前綴行 / body / tip），多數 client 順序合併能看到全部，但 Claude Code 的 UI
    // 摺疊卡片會吃掉多 part 之間的視覺、最後一段的 tip 完全藏起來。改成一段所有
    // client 一致。語意：v1.17.7 起 tip 每次都附（不是每 10 次一次）。
    return composeToolResponse({
      broadcastText,
      tag,
      body,
      tip: getRandomTip(),
      tipTag: formatTag('技巧提示'),
    });
  } catch (error) {
    logEvent('error', enrichErrorDetails(error, name, args));
    const tag = formatTag('錯誤回報');
    return {
      content: [
        {
          type: "text",
          text: `${tag}：${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// --- Auto-update check (background, non-blocking) ---
// v1.17.22 修：Eric (Windows LAPTOP-G95HIQ3V) / Adam 卡舊版的 root cause
//   1. process.env.HOME 在 Windows 是 undefined，OWNMIND_DIR 變相對路徑 → 整段 silent skip
//      → 改用 os.homedir()（跨平台 — Windows 自動讀 USERPROFILE）
//   2. exec(bashScript) 的 bash 語法在 Windows cmd 解釋失敗 → 即使路徑對也不會升
//      → 改用 execFile 走 git/npm 二進位，跨平台
//   3. 條件不成立時原本 silent return → 加 update_skipped event 提供觀測
const OWNMIND_DIR = path.join(os.homedir(), '.ownmind');
const MARKER_FILE = path.join(OWNMIND_DIR, '.last-mcp-update-check');
const LOCK_FILE = path.join(OWNMIND_DIR, '.update-lock');
const IS_WINDOWS = process.platform === 'win32';
const NPM_CMD = IS_WINDOWS ? 'npm.cmd' : 'npm';

import { execFile as _execFile } from 'child_process';
import { promisify } from 'util';
const execFile = promisify(_execFile);

// v1.17.60: 用 module-scope 旗標讓「runAutoUpdate 內部」與「外層 catch」共享狀態。
// 之前外層 catch 一律 unlinkSync(LOCK_FILE)，未來若引入「acquire lock 之前 throw」
// 的路徑，會誤刪別 process 的 lock。改成只在自己持有時才 cleanup。
let _lockHeld = false;

async function runAutoUpdate() {
  const today = new Date().toISOString().slice(0, 10);
  const lastCheck = fs.existsSync(MARKER_FILE)
    ? fs.readFileSync(MARKER_FILE, 'utf8').trim()
    : '';

  // Stale lock detection
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (lockAge > 5 * 60 * 1000) fs.unlinkSync(LOCK_FILE);
    } catch {}
  }

  // Skip-reason 觀測 — 先前 silent skip 讓 Eric/Adam 卡舊版完全沒人發現
  if (lastCheck === today) {
    logEvent('update_skipped', { source: 'mcp', reason: 'marker_today' });
    return;
  }
  if (!fs.existsSync(path.join(OWNMIND_DIR, '.git'))) {
    logEvent('update_skipped', { source: 'mcp', reason: 'no_git_dir', dir: OWNMIND_DIR });
    return;
  }

  // v1.17.23: atomic lock acquire — 之前 existsSync + writeFileSync 有 TOCTOU race
  // openSync 'wx' = exclusive create，已存在會拋 EEXIST（可區分 lock_held vs disk error）
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.closeSync(fd);
    _lockHeld = true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      logEvent('update_skipped', { source: 'mcp', reason: 'lock_held' });
    } else {
      // v1.18.8: 重構用 errorAliasFields helper、跟 'error' event 共用結構化邏輯
      // error: e.code || e.message 保留原 fallback（向後相容）
      logEvent('update_failed', {
        source: 'mcp',
        step: 'lock',
        error: e.code || e.message,
        ...errorAliasFields(e),
      });
    }
    return;
  }

  logEvent('update_check', { source: 'mcp' });

  const cleanup = () => {
    if (!_lockHeld) return;
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    _lockHeld = false;
  };
  const fail = (step, err) => {
    cleanup();
    logEvent('update_failed', {
      source: 'mcp',
      step,
      error: err?.code || err?.message || String(err).slice(0, 120),
    });
  };

  try {
    // git fetch
    try {
      await execFile('git', ['fetch', '-q'], { cwd: OWNMIND_DIR, timeout: 30000 });
    } catch (e) {
      return fail('fetch', e);
    }

    // 看有沒有新 commit
    let updates = '';
    try {
      const { stdout } = await execFile(
        'git', ['log', 'HEAD..origin/main', '--oneline'],
        { cwd: OWNMIND_DIR, timeout: 10000 }
      );
      updates = String(stdout || '').trim();
    } catch (e) {
      return fail('log', e);
    }

    if (!updates) {
      cleanup();
      try { fs.writeFileSync(MARKER_FILE, today); } catch {}
      logEvent('update_clean', { source: 'mcp' });
      return;
    }

    // 有新版，繼續
    // v1.17.23: 用 --autostash（git 2.6+）取代手動 stash／無 pop 流程
    // 之前手動 stash 但沒 pop，user 未提交變更會永遠卡 stash 裡
    // v1.17.65: fallback 不再帶 --autostash（之前主路徑跟 fallback 都帶 --autostash，
    // git < 2.6 兩條都失敗等於沒 fallback）。改 --ff-only：dirty tree 會拒絕並 logEvent，
    // user 看 log 自己處理；絕不做手動 stash（v1.17.22 已驗證沒 pop 會吞變更）。
    try {
      await execFile('git', ['pull', '-q', '--rebase', '--autostash'],
        { cwd: OWNMIND_DIR, timeout: 30000 });
    } catch {
      try {
        await execFile('git', ['pull', '-q', '--ff-only'],
          { cwd: OWNMIND_DIR, timeout: 30000 });
      } catch (e) {
        return fail('pull', e);
      }
    }

    // npm install — Windows 必須用 npm.cmd 並走 shell。
    // v1.17.62: Node v18.20.2 / v20.12.2 / v21.7.3 起為 CVE-2024-27980 修補，禁止 execFile
    // 直接跑 .cmd / .bat 檔，要 shell:true 才行。Adam 的 update_failed step=npm error=EINVAL
    // 就是這個。Mac / Linux 不受影響，所以只在 Windows 開 shell。
    try {
      await execFile(NPM_CMD, ['install', '-q'], {
        cwd: path.join(OWNMIND_DIR, 'mcp'),
        timeout: 120000,
        windowsHide: true,
        shell: IS_WINDOWS,
      });
    } catch (e) {
      return fail('npm', e);
    }

    // 同步 skill / hook：Unix 跑 update.sh、Windows 跑 update.ps1
    try {
      if (IS_WINDOWS) {
        await execFile(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.join(OWNMIND_DIR, 'scripts', 'update.ps1')],
          { cwd: OWNMIND_DIR, timeout: 60000, windowsHide: true }
        );
      } else {
        await execFile('bash', [path.join(OWNMIND_DIR, 'scripts', 'update.sh')],
          { cwd: OWNMIND_DIR, timeout: 60000 });
      }
    } catch (e) {
      return fail('update_sh', e);
    }

    cleanup();
    try { fs.writeFileSync(MARKER_FILE, today); } catch {}
    logEvent('update_applied', { source: 'mcp' });

    // v1.17.62: 升級成功後重發一次心跳，讀磁碟上**新版** package.json，
    // 不等 user 重啟 AI 工具就讓 server 看到新版號。
    // 為什麼要這樣：CLIENT_VERSION 是 module-load 時 cache 的常數，自動更新後磁碟更新但
    // 這個 process 記憶體裡還是舊值。先前的 sendMcpHeartbeat 用 cached 值且 heartbeatSent
    // 旗標每個 process 只送一次心跳 → 長跑的 MCP process 永遠回報舊版號（Michelle / Eric 卡住的原因）。
    // 跑 5 秒 timeout（callApi 本身沒 timeout）；失敗就 log 一個觀測 event。
    try {
      const rootPkg = new URL('../package.json', import.meta.url);
      const freshVersion = JSON.parse(fs.readFileSync(rootPkg, 'utf8')).version;
      if (freshVersion && freshVersion !== CLIENT_VERSION) {
        await Promise.race([
          callApi('POST', '/api/usage/events', {
            events: [],
            heartbeat: {
              tool: CLIENT_TOOL,
              scanner_version: freshVersion,
              machine: os.hostname(),
              os: os.platform(),
            },
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('heartbeat_timeout_5s')), 5000)),
        ]);
      }
    } catch (e) {
      // 失敗就 log，方便 dashboard 監看新版補心跳的有效性
      try {
        logEvent('update_heartbeat_failed', {
          source: 'mcp',
          error: e?.code || e?.message || String(e).slice(0, 120),
        });
      } catch {}
    }
  } catch (e) {
    fail('unknown', e);
  }
}

// fire-and-forget — 不阻塞 MCP 啟動
// v1.17.23: catch 不再 silent — 任何意外都寫 update_failed step=outer
// v1.17.60: 只在自己持有 lock 時才 cleanup，避免誤刪別 process 的 lock
runAutoUpdate().catch((e) => {
  try {
    logEvent('update_failed', {
      source: 'mcp',
      step: 'outer',
      error: e?.code || e?.message || String(e).slice(0, 120),
    });
  } catch {}
  if (_lockHeld) {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    _lockHeld = false;
  }
});

// --- Emergency shutdown: 保存 session log ---
async function emergencySessionLog(reason = 'mcp_shutdown') {
  if (sessionLogged || !sessionStartTime) return;
  const totalCalls = Object.values(toolCallCounts).reduce((a, b) => a + b, 0);
  if (totalCalls <= 1) return; // 只有 init，不記錄
  sessionLogged = true; // 防止重複觸發

  const summary = `[auto] ${AUTO_PROJECT ? AUTO_PROJECT + ' · ' : ''}${Object.entries(toolCallCounts).map(([k, v]) => `${k}:${v}`).join(', ')}`;
  // v1.17.37: 自動帶 project + duration_turns 讓報告頁能歸類專案
  const turns = Math.max(1, Math.round(totalCalls / 2));  // 估算對話輪次（每 turn 約 2 個 tool call）
  const details = {
    _recovery: reason,
    project: AUTO_PROJECT || undefined,  // ⚠️ undefined 會被 sanitizeDetails 移除
    duration_ms: Date.now() - sessionStartTime,
    duration_turns: turns,
    tool_calls: { ...toolCallCounts },
    compliance: [...complianceEvents],
  };

  // 1. 寫入本地日誌 JSONL（防斷電、網路中斷）
  logEvent('session_log_emergency', { summary, ...details });

  // 2. best-effort POST to server，加逾時
  try {
    await Promise.race([
      callApi('POST', '/api/session', {
        summary,
        tool: TOOL_NAME,
        model: 'unknown',
        details,
        sync_token: currentSyncToken,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch {
    // Silent fail — local JSONL is the safety net
  }
}

// v1.17.37: 多種退出 signal 都觸發 — SIGTERM/SIGINT 是 graceful，
// SIGHUP 是 terminal close、process.on('exit') 是同步保險最後機會
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
  process.on(sig, async () => {
    await emergencySessionLog('signal_' + sig);
    process.exit(0);
  });
}
// 'exit' 是同步事件，async 寫入沒法完成；只能 fire-and-forget logEvent (本地 JSONL)
process.on('exit', () => {
  if (!sessionLogged && sessionStartTime) {
    const totalCalls = Object.values(toolCallCounts).reduce((a, b) => a + b, 0);
    if (totalCalls > 1) {
      logEvent('session_log_emergency', {
        summary: `[exit_sync] ${AUTO_PROJECT ? AUTO_PROJECT + ' · ' : ''}${totalCalls} calls`,
        project: AUTO_PROJECT,
        _recovery: 'process_exit',
        tool_calls: { ...toolCallCounts },
      });
    }
  }
});

// Fire-and-forget heartbeat on every MCP startup so already-installed users
// appear as "installed" in Admin without manually running ownmind_init.
// UPSERT keyed by (user_id, tool) — repeat calls just refresh last_reported_at.
sendMcpHeartbeat();

const transport = new StdioServerTransport();
await server.connect(transport);
