/**
 * shared/scanners/opencode.js
 *
 * OpenCode SQLite adapter — 讀 `~/.local/share/opencode/opencode.db`
 *
 * 實際 schema（vs plan spec 假設）：
 *   message.id        TEXT PRIMARY KEY  — 非整數！是 ULID-ish msg_xxx
 *   message.session_id TEXT
 *   message.time_created INTEGER (ms since epoch)
 *   message.data      TEXT (JSON)
 *
 * ⚠️ Plan P5 原本假設 id 是 INTEGER（會用 `id > ?` 數字比較）；實際是 TEXT。
 * 為避免 `"9" > "10"` 字典序 bug，本 adapter 採 **composite cursor**：
 *   (high_water_time, high_water_id)，WHERE (time_created > ? OR (time_created = ? AND id > ?))
 *
 * time_created 是 INTEGER 單調遞增，ties 時退回 id 字串比較（此處退回字典序是 OK 的，
 * 因為只在同一毫秒內發生的 msg 之間排序，且 server UNIQUE 做最終 dedupe）。
 *
 * cumulative_total_tokens（D7）：scanner 維護 session → running_total map。
 * 按 global (time_created, id) ORDER BY 讀時用 session_id 獨立累加，session 切換不 reset。
 *
 * sqlite3 CLI via `-json` 模式，零新 deps（plan P5 要求）。
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';

const execFileP = promisify(execFile);
const DEFAULT_DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const TOOL = 'opencode';
const SOURCE_KEY = 'opencode';  // 全域單一 cursor，不按檔分

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

      // Composite cursor：避免同 ms 內 tie 遺漏 / 重送
      // ORDER BY 與 cursor 條件 同鍵順序，確保下一輪接續
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
        // ENOENT = sqlite3 CLI 不存在（Windows 預設、minimal Linux container）
        // 區別出來讓 installer / user 馬上知道要裝 sqlite3 或傳 sqlitePath
        if (err.code === 'ENOENT') {
          logger?.warn?.(
            `[opencode scanner] sqlite3 CLI not found at '${sqlitePath}'. ` +
            `Install sqlite3 or pass sqlitePath option. Skipping OpenCode scan.`
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
// Helpers（純函式可單測）
// ────────────────────────────────────────────────────────────

function makeHeartbeat(scannerVersion, machine) {
  return { tool: TOOL, scanner_version: scannerVersion, machine };
}

function sqlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 把單筆 SQLite row + session cumulative map 轉成 event（純函式）。
 * data 解析失敗或非 assistant role → null。
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
 * 預設的 sqlite3 CLI runner — 用 `-json` 模式取 array-of-objects。
 * 可注入 runSqlite 方便 test 模擬（帶預設 fixture）。
 */
async function defaultRunSqlite({ sqlitePath, dbPath, sql }) {
  const { stdout } = await execFileP(sqlitePath, [
    '-json', '-readonly', dbPath, sql
  ], { maxBuffer: 100 * 1024 * 1024 });
  const text = stdout.trim();
  if (!text) return [];
  return JSON.parse(text);
}
