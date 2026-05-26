import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
// Node 18+ has global fetch — node-fetch is not required (dependency removed in v1.17.99).

const LOGS_DIR = join(process.env.HOME || '', '.ownmind', 'logs');
// v1.18.4: fallback changed from 'unknown' to 'claude-code', so we don't end up with a flood
// of activity_logs tagged 'unknown' that would break per-tool grouping. Aligned with the
// CLIENT_TOOL design at mcp/index.js:167. The OWNMIND_TOOL env var still takes priority —
// backward compatible.
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
// Do not call process.exit() — let index.js's shutdown handler take over.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    flushToServer();
  });
}

// Important event types: flush immediately, do not wait for the buffer to fill.
const IMMEDIATE_FLUSH_EVENTS = new Set([
  'iron_rule_compliance',
  'session_log',
]);

// v1.20.1: extracted to keep the test and logEvent from disagreeing on what "today" means.
// Originally the test used toISOString().slice(0,10) (UTC), while logEvent used local-time
// getFullYear/Month/Date. Around midnight, the 8-hour UTC-vs-Taipei gap caused the test to
// look at the wrong file and flake. Per IR-032 (timezone discipline), OwnMind defines "today"
// in the user's local timezone.
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

    // v1.17.99: generate a client_event_id (UUID v4) per event so the server can dedup with
    // a (user_id, client_event_id) partial unique index.
    // Scenario: the same logEvent() can re-POST the same event via multiple paths (buffer /
    // scheduleFlush / signal flush) → the server skips by matching id. The local JSONL write
    // and the buffer push share the same entry object, so the id is consistent.
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
