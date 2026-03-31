#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { logEvent } from "./ownmind-log.js";

// --- Compliance JSONL log ---
const COMPLIANCE_LOG = path.join(os.homedir(), '.ownmind/logs/compliance.jsonl');

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

function deriveEvent(rule_title, rule_code) {
  const rules = getCachedVerifiableRules();
  const rule = rules.find(r => r.code === rule_code || r.title === rule_title);
  if (rule?.metadata?.verification?.compliance_event) {
    return rule.metadata.verification.compliance_event;
  }
  return rule_code || rule_title;
}

function detectTriggerFromContext(context) {
  if (!context) return null;
  const lower = context.toLowerCase();
  if (lower.includes('commit')) return 'commit';
  if (lower.includes('deploy') || lower.includes('部署')) return 'deploy';
  if (lower.includes('delete') || lower.includes('刪除')) return 'delete';
  return null;
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
function auditSession() {
  try {
    if (!sessionStartTime) return { commits_checked: 0, violations_found: 0, violations: [] };
    const since = new Date(sessionStartTime).toISOString();
    const gitLog = execSync(`git log --since="${since}" --format="%H" 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (!gitLog) return { commits_checked: 0, violations_found: 0, violations: [] };

    const commitHashes = gitLog.split('\n').filter(Boolean);
    const rules = getCachedVerifiableRules().filter(r =>
      r.metadata?.verification?.trigger?.includes('commit')
    );

    if (rules.length === 0 || !evaluateConditions) {
      return { commits_checked: commitHashes.length, violations_found: 0, violations: [] };
    }

    const violations = [];
    for (const hash of commitHashes) {
      for (const rule of rules) {
        const sessionChecks = extractSessionChecks(rule.metadata.verification.conditions);
        if (sessionChecks.length === 0) continue;

        const ctx = { complianceEvents };
        const result = evaluateConditions({ operator: 'AND', checks: sessionChecks }, ctx);
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

    // Record violations to JSONL
    const logDir = path.dirname(COMPLIANCE_LOG);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    for (const v of violations) {
      const entry = JSON.stringify({
        event: 'session_audit_violation',
        action: 'violate',
        rule_code: v.rule_code,
        rule_title: v.rule_title,
        commit_hash: v.commit_hash,
        failures: v.failures,
        ts: new Date().toISOString()
      });
      fs.appendFileSync(COMPLIANCE_LOG, entry + '\n');
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

// --- Config from env ---
const API_URL = (process.env.OWNMIND_API_URL || "http://localhost:3100").replace(
  /\/$/,
  ""
);
const API_KEY = process.env.OWNMIND_API_KEY || "";

// --- Version & Sync Token (in-memory, per session) ---
const CLIENT_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
})();
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
const TOOL_NAME = process.env.OWNMIND_TOOL || 'unknown';
let sessionStartTime = null;
const toolCallCounts = {};
let complianceEvents = [];
let sessionLogged = false;

// --- Helper ---
async function callApi(method, path, body) {
  const url = `${API_URL}${path}`;
  const headers = {
    "Content-Type": "application/json",
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
    description: "儲存一筆新記憶。可指定類型、標題、內容，以及選填的 code、tags、metadata。",
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
    description: "儲存或更新一筆 secret。",
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
      const data = await callApi("GET", `/api/memory/init?client_version=${CLIENT_VERSION}&compact=true`);
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

      // Eagerly load verification engine
      getEvaluateConditions().catch(() => {});

      logEvent('init', { status: 'ok', details: { rules: data.iron_rules?.length || 0, profile: !!data.profile, handoff: !!data.active_handoff, version: data.server_version } });
      return data;
    }

    case "ownmind_get": {
      const tokenParam = currentSyncToken ? `?sync_token=${currentSyncToken}` : '';
      const data = await callApi("GET", `/api/memory/type/${encodeURIComponent(args.type)}${tokenParam}`);
      if (data.new_token) currentSyncToken = data.new_token;
      logEvent('memory_get', { type: args.type });
      return data;
    }

    case "ownmind_search": {
      const searchTokenParam = currentSyncToken ? `&sync_token=${currentSyncToken}` : '';
      const data = await callApi(
        "GET",
        `/api/memory/search?q=${encodeURIComponent(args.query)}${searchTokenParam}`
      );
      if (data.new_token) currentSyncToken = data.new_token;
      logEvent('memory_search', { query: args.query });
      return data;
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
      const data = await callApi("POST", "/api/memory", body);
      if (data.sync_token) currentSyncToken = data.sync_token;
      logEvent('memory_save', { type: args.type, title: args.title });
      return data;
    }

    case "ownmind_update": {
      const body = { update_reason: args.update_reason, sync_token: currentSyncToken };
      if (args.content !== undefined) body.content = args.content;
      if (args.tags !== undefined) body.tags = args.tags;
      if (args.metadata !== undefined) body.metadata = args.metadata;
      const data = await callApi("PUT", `/api/memory/${args.id}`, body);
      if (data.sync_token) currentSyncToken = data.sync_token;
      logEvent('memory_update', { id: args.id, reason: args.update_reason });
      return data;
    }

    case "ownmind_disable": {
      const data = await callApi("PUT", `/api/memory/${args.id}/disable`, {
        reason: args.reason,
        sync_token: currentSyncToken,
      });
      if (data.sync_token) currentSyncToken = data.sync_token;
      logEvent('memory_disable', { id: args.id, reason: args.reason });
      return data;
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
        const auditResult = auditSession();
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

    case "ownmind_report_compliance": {
      complianceEvents.push({ rule: args.rule_title, action: args.action, rule_code: args.rule_code || '', ts: new Date().toISOString() });
      logEvent('iron_rule_compliance', {
        rule_title: args.rule_title,
        rule_code: args.rule_code || null,
        action: args.action,
        context: args.context || null,
      });

      // E1: Write to compliance JSONL
      try {
        const logDir = path.dirname(COMPLIANCE_LOG);
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const logEntry = JSON.stringify({
          event: deriveEvent(args.rule_title, args.rule_code),
          action: args.action,
          rule_code: args.rule_code || '',
          rule_title: args.rule_title,
          ts: new Date().toISOString(),
          session_id: sessionStartTime ? String(sessionStartTime) : ''
        });
        fs.appendFileSync(COMPLIANCE_LOG, logEntry + '\n');
      } catch { /* silent fail — don't block compliance reporting */ }

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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleTool(name, args || {});
    const typeName = resolveType(name, args);
    const tag = formatTag(typeName);
    const body = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return {
      content: [
        { type: "text", text: `${tag}：` },
        { type: "text", text: body },
        { type: "text", text: `${formatTag('技巧提示')}：${getRandomTip()}` },
      ],
    };
  } catch (error) {
    logEvent('error', { tool_name: name, error: error.message });
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
import { exec } from 'child_process';

const OWNMIND_DIR = path.join(process.env.HOME || '', '.ownmind');
const MARKER_FILE = path.join(OWNMIND_DIR, '.last-mcp-update-check');
const LOCK_FILE = path.join(OWNMIND_DIR, '.update-lock');

try {
  const today = new Date().toISOString().slice(0, 10);
  const lastCheck = fs.existsSync(MARKER_FILE) ? fs.readFileSync(MARKER_FILE, 'utf8').trim() : '';

  // Stale lock detection: if lock file is older than 5 minutes, remove it
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (lockAge > 5 * 60 * 1000) fs.unlinkSync(LOCK_FILE);
    } catch {}
  }

  if (lastCheck !== today && fs.existsSync(path.join(OWNMIND_DIR, '.git')) && !fs.existsSync(LOCK_FILE)) {
    logEvent('update_check', { source: 'mcp' });
    exec(`
      touch "${LOCK_FILE}" &&
      cd ~/.ownmind &&
      git fetch -q 2>/dev/null &&
      UPDATES=$(git log HEAD..origin/main --oneline 2>/dev/null) &&
      if [ -n "$UPDATES" ]; then
        git stash -q 2>/dev/null;
        git pull -q --rebase 2>/dev/null ||
        git pull -q 2>/dev/null;
        cd mcp && npm install -q 2>/dev/null;
        bash ~/.ownmind/scripts/update.sh 2>/dev/null;
      fi &&
      echo "${today}" > "${MARKER_FILE}";
      rm -f "${LOCK_FILE}"
    `, { timeout: 60000, cwd: OWNMIND_DIR }, (err) => {
      if (err) logEvent('update_fail', { source: 'mcp', error: err.message });
      else logEvent('update_applied', { source: 'mcp' });
    });
  }
} catch {
  // Silent fail — never block MCP startup
}

// --- Emergency shutdown: 搶救 session log ---
async function emergencySessionLog() {
  if (sessionLogged || !sessionStartTime) return;
  const totalCalls = Object.values(toolCallCounts).reduce((a, b) => a + b, 0);
  if (totalCalls <= 1) return; // 只有 init，沒做事

  const summary = `[emergency] ${Object.entries(toolCallCounts).map(([k, v]) => `${k}:${v}`).join(', ')}`;
  const details = {
    _recovery: 'mcp_shutdown',
    duration_ms: Date.now() - sessionStartTime,
    tool_calls: { ...toolCallCounts },
    compliance: [...complianceEvents],
  };

  // 1. 同步寫本地 JSONL（保證存活）
  logEvent('session_log_emergency', { summary, ...details });

  // 2. best-effort POST to server（3 秒 timeout）
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

  process.exit(0);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => emergencySessionLog());
}

// --- Start ---
const transport = new StdioServerTransport();
await server.connect(transport);
