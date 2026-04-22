/**
 * shared/scanners/vscode-telemetry.js
 *
 * Cursor / Antigravity 都是 VSCode-based，使用相同結構的 state.vscdb：
 *   ItemTable(key TEXT, value TEXT)
 *   - telemetry.firstSessionDate
 *   - telemetry.lastSessionDate
 *   - telemetry.currentSessionDate
 *
 * Value 是 RFC 2822 字串（e.g. "Wed, 04 Mar 2026 09:21:36 GMT"）。
 *
 * 這裡抽共用讀取函式，以及把 Date → Asia/Taipei YYYY-MM-DD 的純函式。
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
 * 讀取 state.vscdb 三個 telemetry key 成 Date 物件。
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
        `Install sqlite3 or pass sqlitePath option.`
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
 * Asia/Taipei 的 YYYY-MM-DD。純函式。
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
 * 通用 session_count adapter：
 *   - 讀取 currentSessionDate 對應的 Taipei 日期
 *   - 若跟 state[sourceKey].last_session_date 不同 → emit 1 筆 session record
 *   - 與 last 無變化 → 不重發（UPSERT idempotent，無害）
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
      const sourceKey = tool;  // 全域單一 cursor，不按檔分
      const prev = state[sourceKey] || {};
      const prevSessionDate = prev.last_session_date || null;

      const t = await readVscodeTelemetry({ dbPath, sqlitePath, runSqlite, logger });
      const cur = t.currentSessionDate ?? t.lastSessionDate ?? null;
      if (!cur) {
        // DB 不存在或 telemetry 欄位全空 — 不 emit session，但仍送 heartbeat
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
        events: [],           // Tier 2 無 token
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
