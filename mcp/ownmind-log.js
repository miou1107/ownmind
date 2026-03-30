import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';

const LOGS_DIR = join(process.env.HOME || '', '.ownmind', 'logs');
const TOOL_NAME = process.env.OWNMIND_TOOL || 'unknown';
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
    const ts = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + 'T' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0') +
      sign + hh + ':' + mm;

    const dateStr = ts.slice(0, 10);
    const filePath = join(LOGS_DIR, `${dateStr}.jsonl`);

    const tool = details.tool || TOOL_NAME;
    const source = details.source || 'mcp';
    const { tool: _t, source: _s, ...rest } = details;
    const entry = { ts, event, tool, source, details: rest };

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
