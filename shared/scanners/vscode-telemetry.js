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
 * @param {object} opts - { tool, dbPath, sqlitePath, runSqlite, scannerVersion, machine, logger }
 * @returns {Promise<{tool, readSince}>}
 */
export function createVscodeAdapter(opts) {
  const {
    tool, dbPath,
    sqlitePath = 'sqlite3', runSqlite = defaultRunSqlite,
    scannerVersion = 'unknown',
    machine = null,
    logger = null
  } = opts;

  return {
    tool,

    async readSince(state) {
      const sourceKey = tool;  // single global cursor, not per-file
      const prev = state[sourceKey] || {};
      const prevSessionDate = prev.last_session_date || null;

      const t = await readVscodeTelemetry({ dbPath, sqlitePath, runSqlite, logger });
      const cur = t.currentSessionDate ?? t.lastSessionDate ?? null;
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
