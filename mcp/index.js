#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import { logEvent } from "./ownmind-log.js";

// --- Config from env ---
const API_URL = (process.env.OWNMIND_API_URL || "http://localhost:3100").replace(
  /\/$/,
  ""
);
const API_KEY = process.env.OWNMIND_API_KEY || "";

// --- Version & Sync Token (in-memory, per session) ---
const CLIENT_VERSION = '1.10.0';
let currentSyncToken = null;

// --- Session tracking (for emergency shutdown log) ---
const TOOL_NAME = process.env.OWNMIND_TOOL || 'unknown';
let sessionStartTime = null;
const toolCallCounts = {};
const complianceEvents = [];
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
      required: ["summary"],
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
      const data = await callApi("GET", `/api/memory/init?client_version=${CLIENT_VERSION}&compact=true`);
      if (data.sync_token) {
        currentSyncToken = data.sync_token;
      }
      if (data.upgrade_action?.required) {
        data._upgrade_notice = `⚠️ ${data.upgrade_action.message}\n執行：${data.upgrade_action.command}`;
      }
      data._client_version = CLIENT_VERSION;
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
      complianceEvents.push({ rule: args.rule_title, action: args.action });
      logEvent('iron_rule_compliance', {
        rule_title: args.rule_title,
        rule_code: args.rule_code || null,
        action: args.action,
        context: args.context || null,
      });
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
    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    logEvent('error', { tool_name: name, error: error.message });
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// --- Auto-update check (background, non-blocking) ---
import { exec } from 'child_process';
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

const OWNMIND_DIR = join(process.env.HOME || '', '.ownmind');
const MARKER_FILE = join(OWNMIND_DIR, '.last-mcp-update-check');
const LOCK_FILE = join(OWNMIND_DIR, '.update-lock');

try {
  const today = new Date().toISOString().slice(0, 10);
  const lastCheck = existsSync(MARKER_FILE) ? readFileSync(MARKER_FILE, 'utf8').trim() : '';

  // Stale lock detection: if lock file is older than 5 minutes, remove it
  if (existsSync(LOCK_FILE)) {
    try {
      const lockAge = Date.now() - statSync(LOCK_FILE).mtimeMs;
      if (lockAge > 5 * 60 * 1000) unlinkSync(LOCK_FILE);
    } catch {}
  }

  if (lastCheck !== today && existsSync(join(OWNMIND_DIR, '.git')) && !existsSync(LOCK_FILE)) {
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
