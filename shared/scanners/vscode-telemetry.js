/**
 * shared/scanners/vscode-telemetry.js
 *
 * Cursor and Antigravity are both VSCode-based and use the same state.vscdb
 * shape:
 *   ItemTable(key TEXT, value TEXT)
 *   - telemetry.firstSessionDate
 *   - telemetry.lastSessionDate
 *   - telemetry.currentSessionDate
 *
 * Value is an RFC 2822 string (e.g. "Wed, 04 Mar 2026 09:21:36 GMT").
 *
 * This module provides the shared reader and a pure function turning Date
 * into Asia/Taipei YYYY-MM-DD.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execFileP = promisify(execFile);

export const TELEMETRY_KEYS = [
  'telemetry.firstSessionDate',
  'telemetry.lastSessionDate',
  'telemetry.currentSessionDate'
];

/**
 * Read the three telemetry keys from state.vscdb as Date objects.
 *
 * @param {{ dbPath: string, sqlitePath?: string, runSqlite?: Function, logger?: object }}
 * @returns {{ firstSessionDate?: Date, lastSessionDate?: Date, currentSessionDate?: Date }}
 */
export async function readVscodeTelemetry({
  dbPath, sqlitePath = 'sqlite3',
  runSqlite = defaultRunSqlite, logger = null
}) {
  const sql = `SELECT key, value FROM ItemTable
                WHERE key IN (${TELEMETRY_KEYS.map(sqlQuote).join(',')})`;
  let rows;
  try {
    rows = await runSqlite({ sqlitePath, dbPath, sql });
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger?.warn?.(
        `[vscode-telemetry] sqlite3 CLI not found at '${sqlitePath}'. ` +
        `Install: Windows \`winget install SQLite.SQLite\`, ` +
        `Linux \`apt install sqlite3\`, or download from ` +
        `https://www.sqlite.org/download.html — reopen terminal afterwards. ` +
        `Without it, Cursor/Antigravity Tier 2 session_count cannot be collected ` +
        `(Mac has it built in).`
      );
    } else {
      logger?.warn?.(`[vscode-telemetry] sqlite query failed (${dbPath}): ${err.message}`);
    }
    return {};
  }

  const out = {};
  for (const r of rows || []) {
    const camel = keyToCamel(r.key);
    const d = new Date(r.value);
    if (camel && !Number.isNaN(d.getTime())) out[camel] = d;
  }
  return out;
}

/**
 * Asia/Taipei YYYY-MM-DD. Pure function.
 */
export function toTaipeiYmd(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(date);
}

/**
 * Generic session_count adapter:
 *   - Read the Taipei-local date matching currentSessionDate.
 *   - If it differs from state[sourceKey].last_session_date → emit one
 *     session record.
 *   - No change → don't resend (UPSERT is idempotent and harmless).
 *
 * v1.26.66 — a tool may write to more than one directory over its lifetime. Antigravity
 * renamed its storage directory from `Antigravity` to `Antigravity IDE`, and the
 * adapter kept reading the abandoned one: a date frozen in the past, no new session to
 * emit, no error anywhere, and a healthy heartbeat every two hours for eleven weeks.
 * Pass `dbPaths` to look in several places and use the freshest.
 *
 * `dbPath` and `dbPaths` mean different things on purpose. `dbPath` is a caller
 * asserting "read this file" and is read directly, exactly as before. `dbPaths` is
 * "find which of these is installed", so its entries are filtered by existence first —
 * otherwise every single-install machine would log a failed query for the sibling
 * directory on every scan, and a warning that fires on healthy machines stops being
 * read.
 *
 * @param {object} opts - { tool, dbPath | dbPaths, sqlitePath, runSqlite, exists,
 *                          scannerVersion, machine, logger }
 * @returns {{tool: string, readSince: Function}}
 */
export function createVscodeAdapter(opts) {
  const {
    tool, dbPath, dbPaths,
    sqlitePath = 'sqlite3', runSqlite = defaultRunSqlite,
    exists = defaultExists,
    scannerVersion = 'unknown',
    machine = null,
    logger = null
  } = opts;

  const candidates = dbPaths ?? (dbPath == null ? [] : [dbPath]);
  const skipMissing = dbPaths != null;

  return {
    tool,

    async readSince(state) {
      const sourceKey = tool;  // single global cursor, not per-file
      const prev = state[sourceKey] || {};
      const prevSessionDate = prev.last_session_date || null;

      const cur = await readFreshestSessionDate({
        candidates, skipMissing, exists, sqlitePath, runSqlite, logger
      });
      if (!cur) {
        // DB missing or telemetry fields empty — no session emitted, still
        // send a heartbeat.
        return {
          events: [],
          sessions: [],
          offsetPatch: {},
          cumulativePatch: {},
          heartbeat: { tool, scanner_version: scannerVersion, machine }
        };
      }

      const today = toTaipeiYmd(cur);
      const sessions = [];
      const offsetPatch = {};

      if (today && today !== prevSessionDate) {
        sessions.push({ tool, date: today, count: 1, wall_seconds: 0 });
        offsetPatch[sourceKey] = {
          last_session_date: today,
          last_scan: new Date().toISOString()
        };
      }

      return {
        events: [],           // Tier 2 has no tokens
        sessions,
        offsetPatch,
        cumulativePatch: {},
        heartbeat: { tool, scanner_version: scannerVersion, machine }
      };
    }
  };
}

// ────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────

/**
 * How far ahead of now a session date may be and still be believed. Timezone handling
 * and ordinary clock drift move things by hours; a rolled-forward system clock moves
 * them by months.
 */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * Latest session Date across the candidate databases, or null.
 *
 * The `currentSessionDate ?? lastSessionDate` fallback is applied *per candidate*
 * before comparing. Comparing currentSessionDate across all candidates first and only
 * then falling back would let a stale install with a currentSessionDate beat a live one
 * that happens to expose only lastSessionDate.
 *
 * A date beyond FUTURE_TOLERANCE_MS is discarded. Taking the maximum blindly means one
 * abandoned database holding a future timestamp wins every comparison forever: it is
 * emitted once, the cursor advances to it, and the live install's real dates are
 * silently suppressed from then on. That converts one dead directory into a dead tool,
 * which is worse than the bug this candidate list exists to fix.
 */
async function readFreshestSessionDate({
  candidates, skipMissing, exists, sqlitePath, runSqlite, logger
}) {
  const ceiling = Date.now() + FUTURE_TOLERANCE_MS;
  let newest = null;
  for (const dbPath of candidates) {
    if (skipMissing && !(await exists(dbPath))) continue;
    const t = await readVscodeTelemetry({ dbPath, sqlitePath, runSqlite, logger });
    const d = t.currentSessionDate ?? t.lastSessionDate ?? null;
    if (!d) continue;
    if (d.getTime() > ceiling) {
      logger?.warn?.(
        `[vscode-telemetry] ignoring future session date ${d.toISOString()} ` +
        `from ${dbPath}; the clock that wrote it was wrong`
      );
      continue;
    }
    if (newest === null || d > newest) newest = d;
  }
  return newest;
}

/**
 * Whether a candidate database is installed on this machine.
 *
 * Only ENOENT counts as "not installed". Any other failure — a permission wall on a
 * parent directory, an I/O error, a home directory that resolved onto a regular file —
 * means the question could not be answered, and answering "absent" would drop the
 * candidate before sqlite is ever invoked, taking the warning with it. Letting it
 * through costs one failed query and one log line on a machine that is genuinely
 * broken, which is the right side to be wrong on.
 */
export async function defaultExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
}

function keyToCamel(key) {
  switch (key) {
    case 'telemetry.firstSessionDate':   return 'firstSessionDate';
    case 'telemetry.lastSessionDate':    return 'lastSessionDate';
    case 'telemetry.currentSessionDate': return 'currentSessionDate';
    default: return null;
  }
}

function sqlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function defaultRunSqlite({ sqlitePath, dbPath, sql }) {
  const { stdout } = await execFileP(sqlitePath, [
    '-json', '-readonly', dbPath, sql
  ], { maxBuffer: 10 * 1024 * 1024 });
  const text = stdout.trim();
  if (!text) return [];
  return JSON.parse(text);
}
