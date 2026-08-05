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

import path from 'path';
import os from 'os';
import { runSqliteCli, databaseExists } from './sqlite-cli.js';
import { SQLITE_MISSING, UNREADABLE, NO_INSTALL } from './reasons.js';
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
  exists = databaseExists,
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
        // The logger is what separates "the database is locked" from "the temporary
        // directory is full" when the snapshot fallback in sqlite-cli.js also fails.
        rows = await runSqlite({ sqlitePath, dbPath, sql, logger });
      } catch (err) {
        // ENOENT = sqlite3 CLI missing (default on Windows, on minimal Linux
        // containers). Distinguish this so installer / user knows to install
        // sqlite3 or pass sqlitePath.
        let reason;
        if (err.code === 'ENOENT') {
          reason = SQLITE_MISSING;
          logger?.warn?.(
            `[opencode scanner] sqlite3 CLI not found at '${sqlitePath}'. ` +
            `Install: Windows \`winget install SQLite.SQLite\`, ` +
            `Linux \`apt install sqlite3\`, or download from ` +
            `https://www.sqlite.org/download.html — reopen terminal afterwards. ` +
            `Without it, OpenCode Tier 1 usage can never be collected ` +
            `(Mac/Linux usually have it built in).`
          );
        } else {
          // v1.26.71 — `sqlite3` says "unable to open database file" both for a database
          // whose application is closed and for a path with nothing at it. Asking makes
          // "you do not run OpenCode" stop reporting as "your OpenCode is broken", the
          // same question v1.26.69 added for Cursor.
          reason = (await exists(dbPath)) ? UNREADABLE : NO_INSTALL;
          logger?.warn?.(`[opencode scanner] sqlite query failed (${reason}): ${err.message}`);
        }
        // v1.26.71 — without a reason the orchestrator's deriveReason sees no events, no
        // sessions, no file count and no skipped list, and answers `no_new_activity`. A
        // database that cannot be read reported as "he did not use it today" is the
        // false-healthy signal v1.26.69 exists to prevent, and OpenCode never got it.
        return {
          events: [], offsetPatch: {}, cumulativePatch: {}, reason,
          heartbeat: makeHeartbeat(scannerVersion, machine)
        };
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
 * A Tier 1 scan returns every assistant message since the cursor, which on a first scan
 * is the entire history. Tier 2 reads three telemetry rows and allows 10 MB; the same
 * ceiling here would truncate silently.
 */
const MAX_BUFFER = 100 * 1024 * 1024;

/**
 * Default sqlite3 CLI runner. `runSqlite` can be injected for tests (with a pre-built
 * fixture); this is what runs otherwise.
 *
 * v1.26.71 — this used to assemble its own `-readonly` invocation, which meant OpenCode
 * could only be read while OpenCode was running. See `sqlite-cli.js`: the live file is
 * still only ever opened `-readonly`, and a closed one is read from a private snapshot.
 */
export async function defaultRunSqlite(opts) {
  // `?? MAX_BUFFER` rather than spreading `opts` over a default, because a caller that
  // passes `maxBuffer: undefined` would spread that undefined straight through and land
  // on the shared 10 MB default — a silent truncation on exactly the long first scan
  // this ceiling exists for.
  return runSqliteCli({ ...opts, maxBuffer: opts?.maxBuffer ?? MAX_BUFFER });
}
