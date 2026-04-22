/**
 * shared/scanners/claude-code.js
 *
 * Claude Code JSONL adapter — 掃 `~/.claude/projects/<project>/<session>.jsonl`，
 * 每則 type='assistant' 且 message.usage 非空的訊息 → 一筆 raw event。
 *
 * Cursor：檔案路徑 → byte_offset（INT）。只推進不回頭。
 * message_id：直接用 JSONL 的 `uuid`（native，每則必有）。
 *
 * cumulative_total_tokens（D7）：
 *   scanner 維護 session → running_total map
 *   每 event：new = prev + input + output + cache_creation + cache_read
 *   整批 upload 成功後，byte_offset 和 cumulative map 一起原子寫回 offsets 檔
 *   重啟後從檔案 load map → running total 接續，不誤報 regression
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const DEFAULT_BASE_DIR = path.join(os.homedir(), '.claude', 'projects');
const TOOL = 'claude-code';

export function createClaudeCodeAdapter({
  baseDir = DEFAULT_BASE_DIR,
  scannerVersion = 'unknown',
  machine = os.hostname(),
  listFiles = defaultListJsonlFiles,
  readIncremental = defaultReadIncremental,
  logger = null
} = {}) {
  return {
    tool: TOOL,

    async readSince(state) {
      const files = await listFiles(baseDir);
      const events = [];
      const offsetPatch = {};
      const cumulativePatch = {};
      // 從 state load session → running_total map
      const sessionCumulative = {
        ...(state.session_cumulative?.[TOOL] || {})
      };

      for (const file of files) {
        const sourceKey = `${TOOL}:${file}`;
        const prev = state[sourceKey] || {};
        const prevOffset = Number(prev.byte_offset || 0);

        let { lines, nextOffset } = await readIncremental(file, prevOffset);

        for (const line of lines) {
          const parsed = parseAssistantLine(line, { logger });
          if (!parsed) continue;

          const prevCum = sessionCumulative[parsed.session_id] || 0;
          const newCum = prevCum
            + parsed.input_tokens
            + parsed.output_tokens
            + parsed.cache_creation_tokens
            + parsed.cache_read_tokens;

          sessionCumulative[parsed.session_id] = newCum;
          cumulativePatch[parsed.session_id] = newCum;

          events.push({
            tool: TOOL,
            session_id: parsed.session_id,
            message_id: parsed.message_id,
            model: parsed.model,
            ts: parsed.ts,
            input_tokens: parsed.input_tokens,
            output_tokens: parsed.output_tokens,
            cache_creation_tokens: parsed.cache_creation_tokens,
            cache_read_tokens: parsed.cache_read_tokens,
            reasoning_tokens: 0,
            cumulative_total_tokens: newCum,
            source_file: path.basename(file)
          });
        }

        if (nextOffset !== prevOffset) {
          offsetPatch[sourceKey] = {
            byte_offset: nextOffset,
            last_scan: new Date().toISOString()
          };
        }
      }

      const heartbeat = {
        tool: TOOL,
        scanner_version: scannerVersion,
        machine
      };

      return { events, offsetPatch, cumulativePatch, heartbeat };
    }
  };
}

// ────────────────────────────────────────────────────────────
// Helpers（純函式 — 單元測試直接打）
// ────────────────────────────────────────────────────────────

/**
 * 解析單行 JSONL，只回傳 type='assistant' 且 message.usage 非空的 event。
 * 失敗 (invalid JSON / 非 assistant / 無 usage) → 回傳 null。
 *
 * @param {string} line
 * @param {{logger?: {warn?: Function}}} [opts] - 只在 JSON.parse 失敗時 warn（幫助排查
 *        「這個 session 為何少 tokens」）。非 assistant / 缺欄位為正常現象，靜默略過。
 */
export function parseAssistantLine(line, opts = {}) {
  if (!line || typeof line !== 'string') return null;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (err) {
    opts.logger?.warn?.(`[claude-code scanner] malformed JSONL line (len=${line.length}): ${err.message}`);
    return null;
  }
  if (!obj || obj.type !== 'assistant') return null;
  const u = obj.message?.usage;
  if (!u) return null;
  if (!obj.uuid) return null;             // native id 必存在
  if (!obj.timestamp) return null;
  if (!obj.sessionId) return null;

  return {
    session_id: obj.sessionId,
    message_id: obj.uuid,
    model: obj.message.model ?? null,
    ts: obj.timestamp,
    input_tokens: Number(u.input_tokens || 0),
    output_tokens: Number(u.output_tokens || 0),
    cache_creation_tokens: Number(u.cache_creation_input_tokens || 0),
    cache_read_tokens: Number(u.cache_read_input_tokens || 0)
  };
}

async function defaultListJsonlFiles(baseDir) {
  const out = [];
  try {
    const projects = await fs.readdir(baseDir);
    for (const p of projects) {
      const projectDir = path.join(baseDir, p);
      try {
        const s = await fs.stat(projectDir);
        if (!s.isDirectory()) continue;
        const files = await fs.readdir(projectDir);
        for (const f of files) {
          if (f.endsWith('.jsonl')) out.push(path.join(projectDir, f));
        }
      } catch { /* 單一 project dir 無法讀就跳過 */ }
    }
  } catch { /* baseDir 不存在：乾淨環境，回空 */ }
  return out;
}

/**
 * 從 byte_offset 讀到 EOF，切 lines；最後若沒有 \n 結尾表示還有 partial line，
 * 此行不採用、offset 停在該行開頭，等下次 scan 再讀完整。
 *
 * 若 byte_offset > file size（檔案被截斷/輪轉）→ 從 0 重新開始。
 */
export async function defaultReadIncremental(filePath, byteOffset) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    let start = byteOffset;
    if (start > stat.size) start = 0;  // 檔案被截斷
    const length = stat.size - start;
    if (length <= 0) return { lines: [], nextOffset: start };

    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    const text = buf.toString('utf8');

    const endsWithNewline = text.endsWith('\n');
    const parts = text.split('\n');
    // 最後一個 element：若是 '' 代表正常 \n 結尾；否則是 partial line
    // parts.slice(0, -1) 永遠排除最後一個
    const lines = parts.slice(0, -1);
    const lastPartial = endsWithNewline ? '' : parts[parts.length - 1];
    const consumed = length - Buffer.byteLength(lastPartial, 'utf8');

    return { lines, nextOffset: start + consumed };
  } finally {
    await handle.close();
  }
}
