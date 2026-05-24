import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
// Node 18+ 有 global fetch、不需 node-fetch 套件（v1.17.99 移除依賴）

const LOGS_DIR = join(process.env.HOME || '', '.ownmind', 'logs');
// v1.18.4: fallback 從 'unknown' 改 'claude-code'，避免大量 activity_logs
// 標成 'unknown' 導致跨工具分群失效。對齊 mcp/index.js:167 CLIENT_TOOL 設計。
// OWNMIND_TOOL 環境變數仍優先生效，向後相容。
const TOOL_NAME = process.env.OWNMIND_TOOL
  || process.env.OWNMIND_CLIENT_TOOL
  || 'claude-code';
const API_URL = (process.env.OWNMIND_API_URL || '').replace(/\/$/, '');
const API_KEY = process.env.OWNMIND_API_KEY || '';

// Ensure logs directory exists (once per process)
let dirReady = false;
function ensureDir() {
  if (dirReady) return;
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  dirReady = true;
}

// Buffer for batch upload (flush every 10 events or 30 seconds)
const buffer = [];
let flushTimer = null;

async function flushToServer() {
  if (buffer.length === 0 || !API_URL || !API_KEY) return;
  const events = buffer.splice(0, buffer.length);
  try {
    await fetch(`${API_URL}/api/activity/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({ events }),
    });
  } catch {
    // Silent fail — server might be unreachable
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushToServer();
  }, 30000);
  // Don't prevent Node.js from exiting — local JSONL is the source of truth
  flushTimer.unref();
}

// Exit hook: flush remaining buffer before process exits
process.on('beforeExit', () => {
  flushToServer();
});

// Signal hooks: best-effort flush before process is killed
// 不呼叫 process.exit()，讓 index.js 的 shutdown handler 接手
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    flushToServer();
  });
}

// 重要事件類型：立即 flush，不等 buffer 滿
const IMMEDIATE_FLUSH_EVENTS = new Set([
  'iron_rule_compliance',
  'session_log',
]);

// v1.20.1: 抽出來避免 test 跟 logEvent 對「今天」用不同時區（test 原本用
// toISOString().slice(0,10) = UTC、logEvent 用 local time getFullYear/Month/Date）
// 跨午夜 UTC vs 台北 8 小時差時、test 找不到 logEvent 寫的檔導致 flake。
// 按 IR-032 時區強制定標準、OwnMind 站在 user 的本地時區看「今天」。
export function localDateOnly(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

/**
 * Write a structured log event to ~/.ownmind/logs/YYYY-MM-DD.jsonl
 * and buffer for batch upload to server.
 * Never throws — silent fail to avoid disrupting main flow.
 */
export function logEvent(event, details = {}) {
  try {
    ensureDir();
    const now = new Date();
    const tzOffset = -now.getTimezoneOffset();
    const sign = tzOffset >= 0 ? '+' : '-';
    const hh = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
    const mm = String(Math.abs(tzOffset) % 60).padStart(2, '0');
    const dateStr = localDateOnly(now);
    const ts = dateStr + 'T' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0') +
      sign + hh + ':' + mm;

    const filePath = join(LOGS_DIR, `${dateStr}.jsonl`);

    const tool = details.tool || TOOL_NAME;
    const source = details.source || 'mcp';
    const { tool: _t, source: _s, ...rest } = details;

    // v1.17.99: 給每筆事件生 client_event_id (UUID v4)、server 端用
    // (user_id, client_event_id) partial unique index dedup
    // 場景：同一個 logEvent() 因 buffer / scheduleFlush / signal flush 多條
    // path 重複 POST 同事件 → server 對相同 id 跳過。本機 JSONL 寫入跟 buffer
    // push 用同一份 entry 物件、id 一致。
    const entry = { ts, event, tool, source, client_event_id: randomUUID(), details: rest };

    // Write local
    appendFileSync(filePath, JSON.stringify(entry) + '\n');

    // Buffer for server upload
    buffer.push(entry);
    if (buffer.length >= 10 || IMMEDIATE_FLUSH_EVENTS.has(event)) {
      flushToServer();
    } else {
      scheduleFlush();
    }
  } catch {
    // Silent fail — never disrupt main flow
  }
}
