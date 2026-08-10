import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveClientTool, resolveProjectName } from '../shared/helpers.js';
// Node 18+ has global fetch — node-fetch is not required (dependency removed in v1.17.99).

/**
 * v1.26.131 — where this process writes its own activity log.
 *
 * This used to be `join(process.env.HOME || '', '.ownmind', 'logs')`. **HOME is not set on
 * Windows**, so the empty-string fallback made the path relative, and the log landed in
 * whatever directory the host happened to launch the MCP in — or, where that is not
 * writable, nowhere at all, taking the server upload with it (see logEvent).
 *
 * The same line, in the same package, has already cost this project once. The comment above
 * the auto-update block in index.js records v1.17.22: "root cause of Alice (Windows) / Bob
 * being stuck on old versions: process.env.HOME is undefined on Windows". index.js was moved
 * to os.homedir(). Its logger, one import away, was left behind — so the machines that could
 * not update also could not report that they had not updated.
 *
 * Resolved on each call rather than once at import, so a test can exercise the Windows case
 * without a child process. os.homedir() already reads USERPROFILE on Windows; the explicit
 * env reads ahead of it match the shape used by every other file in the repo that needs this.
 */
export function resolveLogsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(home, '.ownmind', 'logs');
}
// v1.18.4: fallback is 'claude-code' rather than 'unknown', so activity_logs does not
// fill with 'unknown' and break per-tool grouping.
//
// v1.26.67: this used to be its own copy of the rule, with a comment claiming it was
// aligned with mcp/index.js. It was not — that copy had dropped OWNMIND_TOOL. Sharing
// the resolver makes the alignment true by construction instead of by assertion.
const TOOL_NAME = resolveClientTool();
// v1.26.98 — resolved once per process, like TOOL_NAME. Every event carries it, so a session
// the server has to rebuild from activity still knows which project it belonged to. Before
// this, "most common project" on the team page was blank for anyone whose AI did not call
// ownmind_log_session. Directory name only, never the path — see resolveProjectName.
const PROJECT_NAME = resolveProjectName();
const API_URL = (process.env.OWNMIND_API_URL || '').replace(/\/$/, '');
const API_KEY = process.env.OWNMIND_API_KEY || '';

// Ensure logs directory exists (once per process)
let dirReady = false;
function ensureDir() {
  const dir = resolveLogsDir();
  if (dirReady) return dir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  dirReady = true;
  return dir;
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
// v1.26.131 — the update outcomes joined this set.
//
// They are the events a machine that cannot update most needs to send, and they happen at
// most once a day, so batching buys nothing. What batching costs is everything: the buffer
// waits for ten events or a thirty-second timer, and a host that terminates its MCP child
// rather than signalling it never runs the beforeExit / SIGTERM flush. Two users sat on
// stale versions unnoticed - one for eight weeks - sending a daily heartbeat and not one
// word about why their updates were not landing.
const IMMEDIATE_FLUSH_EVENTS = new Set([
  'iron_rule_compliance',
  'session_log',
  'update_applied',
  'update_failed',
  'update_skipped',
  'update_clean',
]);

// v1.20.1: extracted to keep the test and logEvent from disagreeing on what "today" means.
// Originally the test used toISOString().slice(0,10) (UTC), while logEvent used local-time
// getFullYear/Month/Date. Around midnight, the 8-hour UTC-vs-Taipei gap caused the test to
// look at the wrong file and flake. Per timezone discipline, OwnMind defines "today"
// in the user's local timezone.
//
// v1.26.124: the definition moved to shared/local-date.js, because keeping it here made it
// reachable only from the MCP — and the Node hooks, which write into the same log directory
// and read the same update marker, had each grown their own UTC copy. Re-exported so the
// existing importers (and tests) keep working.
export { localDateOnly } from '../shared/local-date.js';
import { localDateOnly } from '../shared/local-date.js';

/**
 * Write a structured log event to ~/.ownmind/logs/YYYY-MM-DD.jsonl
 * and buffer for batch upload to server.
 * Never throws — silent fail to avoid disrupting main flow.
 */
export function logEvent(event, details = {}) {
  try {
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

    const tool = details.tool || TOOL_NAME;
    const source = details.source || 'mcp';
    const { tool: _t, source: _s, ...rest } = details;
    // An explicit project in `details` wins: a caller that knows better than the process-wide
    // guess should not have it overwritten.
    if (PROJECT_NAME && rest.project === undefined) rest.project = PROJECT_NAME;

    // v1.17.99: generate a client_event_id (UUID v4) per event so the server can dedup with
    // a (user_id, client_event_id) partial unique index.
    // Scenario: the same logEvent() can re-POST the same event via multiple paths (buffer /
    // scheduleFlush / signal flush) → the server skips by matching id. The local JSONL write
    // and the buffer push share the same entry object, so the id is consistent.
    const entry = { ts, event, tool, source, client_event_id: randomUUID(), details: rest };

    // v1.26.131 — buffer first, write second.
    //
    // These used to be the other way round inside this one try/catch, so an unwritable logs
    // directory did not degrade an event to "sent but not stored locally". It deleted the
    // event outright: appendFileSync threw, the push below it never ran, and the catch said
    // nothing. One filesystem problem cost both copies, and the server-side one is the copy
    // anybody can actually look at.
    buffer.push(entry);
    if (buffer.length >= 10 || IMMEDIATE_FLUSH_EVENTS.has(event)) {
      flushToServer();
    } else {
      scheduleFlush();
    }

    // Local copy, in its own try: it is the more detailed record, and it is also the one
    // that can fail on a machine we cannot inspect. Losing it must not cost the upload.
    try {
      appendFileSync(join(ensureDir(), `${dateStr}.jsonl`), JSON.stringify(entry) + '\n');
    } catch { /* the event is already on its way to the server */ }
  } catch {
    // Silent fail — never disrupt main flow
  }
}
