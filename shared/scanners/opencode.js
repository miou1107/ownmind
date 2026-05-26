/**
 * shared/scanners/opencode.js
 *
 * OpenCode SQLite adapter — reads `~/.local/share/opencode/opencode.db`.
 *
 * Actual schema (vs plan spec assumption):
 *   message.id           TEXT PRIMARY KEY  — NOT integer! ULID-ish msg_xxx
 *   message.session_id   TEXT
 *   message.time_created INTEGER (ms since epoch)
 *   message.data         TEXT (JSON)
 *
 * ⚠️ Plan P5 originally assumed id was INTEGER (would use `id > ?` numeric
 * comparison); actually TEXT. To avoid `"9" > "10"` lexicographic bugs,
 * this adapter uses a **composite cursor**:
 *   (high_water_time, high_water_id),
 *   WHERE (time_created > ? OR (time_created = ? AND id > ?))
 *
 * time_created is a monotonically increasing INTEGER; on ties we fall back
 * to id string comparison (lexicographic is OK here because it only orders
 * messages produced within the same millisecond, and the server's UNIQUE
 * does the final dedupe).
 *
 * cumulative_total_tokens (D7): the scanner keeps a session → running_total
 * map. Iteration order is global (time_created, id); per session_id the
 * total accumulates independently and does not reset across sessions.
 *
 * Uses the sqlite3 CLI in `-json` mode — zero new deps (per plan P5).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';

const execFileP = promisify(execFile);
// v1.17.14 — added win32 path (OpenCode for Windows lives under
// AppData/Roaming/opencode/).
const DEFAULT_DB_PATHS = {
  darwin: path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
  linux: path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
  win32: path.join(os.homedir(), 'AppData', 'Roaming', 'opencode', 'opencode.db'),
};
const DEFAULT_DB = DEFAULT_DB_PATHS[process.platform] ?? DEFAULT_DB_PATHS.linux;
const TOOL = 'opencode';
const SOURCE_KEY = 'opencode';  // single global cursor; not per-file

export function createOpenCodeAdapter({
  dbPath = DEFAULT_DB,
  sqlitePath = 'sqlite3',
  runSqlite = defaultRunSqlite,
  scannerVersion = 'unknown',
  machine = os.hostname(),
  logger = null
} = {}) {
  return {
    tool: TOOL,

    async readSince(state) {
      const cursor = state[SOURCE_KEY] || {};
      const highWaterTime = Number.isFinite(Number(cursor.high_water_time))
        ? Number(cursor.high_water_time) : 0;
      const highWaterId = typeof cursor.high_water_id === 'string' ? cursor.high_water_id : '';

      // Composite cursor: avoid losing/duplicating events tied on the same ms.
      // ORDER BY matches the cursor condition's key order so the next round
      // continues from exactly where we stopped.
      const sql = `
        SELECT id, session_id, time_created, data
        FROM message
        WHERE (time_created > ${Number(highWaterTime).toFixed(0)}
               OR (time_created = ${Number(highWaterTime).toFixed(0)} AND id > ${sqlQuote(highWaterId)}))
          AND json_extract(data, '$.role') = 'assistant'
        ORDER BY time_created ASC, id ASC
      `;

      let rows;
      try {
        rows = await runSqlite({ sqlitePath, dbPath, sql });
      } catch (err) {
        // ENOENT = sqlite3 CLI missing (default on Windows, on minimal Linux
        // containers). Distinguish this so installer / user knows to install
        // sqlite3 or pass sqlitePath.
        if (err.code === 'ENOENT') {
          logger?.warn?.(
            `[opencode scanner] sqlite3 CLI not found at '${sqlitePath}'. ` +
            `Install: Windows \`winget install SQLite.SQLite\`, ` +
            `Linux \`apt install sqlite3\`, or download from ` +
            `https://www.sqlite.org/download.html — reopen terminal afterwards. ` +
            `Without it, OpenCode Tier 2 usage can never be collected ` +
            `(Mac/Linux usually have it built in).`
          );
        } else {
          logger?.warn?.(`[opencode scanner] sqlite query failed: ${err.message}`);
        }
        return { events: [], offsetPatch: {}, cumulativePatch: {}, heartbeat: makeHeartbeat(scannerVersion, machine) };
      }

      const events = [];
      const cumulativePatch = {};
      const sessionCumulative = {
        ...(state.session_cumulative?.[TOOL] || {})
      };

      let newHighTime = highWaterTime;
      let newHighId = highWaterId;

      for (const row of rows) {
        const ev = buildEventFromRow(row, sessionCumulative, { logger });
        if (!ev) continue;
        events.push(ev);
        sessionCumulative[ev.session_id] = ev.cumulative_total_tokens;
        cumulativePatch[ev.session_id] = ev.cumulative_total_tokens;
        newHighTime = Number(row.time_created);
        newHighId = String(row.id);
      }

      const offsetPatch = {};
      if (newHighTime !== highWaterTime || newHighId !== highWaterId) {
        offsetPatch[SOURCE_KEY] = {
          high_water_time: newHighTime,
          high_water_id: newHighId,
          last_scan: new Date().toISOString()
        };
      }

      return {
        events, offsetPatch, cumulativePatch,
        heartbeat: makeHeartbeat(scannerVersion, machine)
      };
    }
  };
}

// ────────────────────────────────────────────────────────────
// Helpers (pure, individually testable)
// ────────────────────────────────────────────────────────────

function makeHeartbeat(scannerVersion, machine) {
  return { tool: TOOL, scanner_version: scannerVersion, machine };
}

function sqlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Turn one SQLite row plus the per-session cumulative map into an event
 * (pure function). Returns null when data fails to parse or role isn't
 * assistant.
 */
export function buildEventFromRow(row, sessionCumulative, { logger } = {}) {
  if (!row || !row.id || !row.session_id) return null;

  let data;
  try { data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; }
  catch (err) {
    logger?.warn?.(`[opencode scanner] data JSON parse failed for id=${row.id}: ${err.message}`);
    return null;
  }

  if (!data || data.role !== 'assistant') return null;
  if (!data.tokens) return null;

  const tokens = data.tokens;
  const cache = tokens.cache || {};
  const input = Number(tokens.input || 0);
  const output = Number(tokens.output || 0);
  const reasoning = Number(tokens.reasoning || 0);
  const cacheRead = Number(cache.read || 0);
  const cacheWrite = Number(cache.write || 0);

  const delta = input + output + reasoning + cacheRead + cacheWrite;
  const prevCum = Number(sessionCumulative?.[row.session_id] || 0);
  const newCum = prevCum + delta;

  const createdMs = Number(data.time?.created ?? row.time_created);
  const ts = Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : null;
  if (!ts) return null;

  return {
    tool: TOOL,
    session_id: String(row.session_id),
    message_id: String(row.id),
    model: data.modelID ?? null,
    ts,
    input_tokens: input,
    output_tokens: output,
    cache_creation_tokens: cacheWrite,
    cache_read_tokens: cacheRead,
    reasoning_tokens: reasoning,
    native_cost_usd: data.cost != null ? Number(data.cost) : null,
    cumulative_total_tokens: newCum,
    source_file: 'opencode.db'
  };
}

/**
 * Default sqlite3 CLI runner — `-json` mode returns array-of-objects.
 * runSqlite can be injected for tests (with a pre-built fixture).
 */
async function defaultRunSqlite({ sqlitePath, dbPath, sql }) {
  const { stdout } = await execFileP(sqlitePath, [
    '-json', '-readonly', dbPath, sql
  ], { maxBuffer: 100 * 1024 * 1024 });
  const text = stdout.trim();
  if (!text) return [];
  return JSON.parse(text);
}
