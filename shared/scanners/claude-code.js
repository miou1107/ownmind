/**
 * shared/scanners/claude-code.js
 *
 * Claude Code JSONL adapter — scans
 * `~/.claude/projects/<project>/<session>.jsonl`. Every type='assistant'
 * message with a non-empty message.usage becomes one raw event.
 *
 * Cursor: file path → byte_offset (INT). Only advances, never rewinds.
 * message_id: uses the JSONL's `uuid` (native, always present).
 *
 * cumulative_total_tokens (D7):
 *   The scanner keeps a session → running_total map.
 *   For each event: new = prev + input + output + cache_creation + cache_read.
 *   Once a batch uploads successfully, byte_offset and the cumulative map
 *   are atomically written back to the offsets file.
 *   After a restart, loading the map lets the running total resume without
 *   false regressions.
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
      const skipped = [];
      // Load session → running_total map from state.
      const sessionCumulative = {
        ...(state.session_cumulative?.[TOOL] || {})
      };

      for (const file of files) {
        const sourceKey = `${TOOL}:${file}`;
        const prev = state[sourceKey] || {};
        const prevOffset = Number(prev.byte_offset || 0);

        // v1.26.65 — one file that cannot be opened used to end the whole scan for
        // this tool, taking the heartbeat with it, because the heartbeat is built
        // after this loop. The file is skipped instead, and its error code is
        // carried out so the scanner log can say what happened.
        let lines, nextOffset;
        try {
          ({ lines, nextOffset } = await readIncremental(file, prevOffset));
        } catch (err) {
          // `err` is not guaranteed to be an Error: a thrown string has no
          // .message, and logging it raw prints the word "undefined" where the
          // reason should be.
          skipped.push(err?.code || 'UNKNOWN');
          logger?.warn?.(`[claude-code scanner] skipped ${file}: ${err?.message || String(err)}`);
          continue;
        }

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

      // v1.26.65 — `scanned` is how many session files were visible this run.
      // Without it `sent=0` is unreadable: a machine that has nothing new and a
      // machine whose data the scanner cannot reach produce the identical line,
      // and on 2026-08-05 that ambiguity sent this investigation down a wrong
      // path for an hour. `sent=0 files=0` and `sent=0 files=37` are different
      // problems and should not look the same.
      return { events, offsetPatch, cumulativePatch, heartbeat, scanned: files.length, skipped };
    }
  };
}

// ────────────────────────────────────────────────────────────
// Helpers (pure — directly unit-testable)
// ────────────────────────────────────────────────────────────

/**
 * Parse one JSONL line; returns an event only when type='assistant' with a
 * non-empty message.usage. On failure (invalid JSON / non-assistant /
 * missing usage) returns null.
 *
 * @param {string} line
 * @param {{logger?: {warn?: Function}}} [opts] - warns only when JSON.parse
 *        fails (helps debug "why is this session missing tokens").
 *        Non-assistant / missing fields are normal and skipped silently.
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
  if (!obj.uuid) return null;             // native id is required
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

/**
 * List every session JSONL under baseDir.
 *
 * v1.26.65 — this used to wrap the whole thing in `catch { }` and return an empty
 * array, with a comment asserting the cause was "baseDir does not exist: clean
 * env". The code could not actually tell that apart from a permission failure or
 * a home directory that resolved somewhere unexpected, and all three came out of
 * the scanner as the single line `sent=0`.
 *
 * That is how a collector stays dead for twenty days while every layer above it
 * reports success. A machine that has never run Claude Code is genuinely silent
 * and stays silent here; anything else is now an error the caller can see.
 */
export async function defaultListJsonlFiles(baseDir) {
  const out = [];
  let projects;
  try {
    projects = await fs.readdir(baseDir);
  } catch (err) {
    if (err.code === 'ENOENT') return out;   // never used this tool: legitimately nothing
    throw err;                               // could not look, which is not the same as nothing to see
  }

  for (const p of projects) {
    const projectDir = path.join(baseDir, p);
    try {
      const s = await fs.stat(projectDir);
      if (!s.isDirectory()) continue;
      const files = await fs.readdir(projectDir);
      for (const f of files) {
        if (f.endsWith('.jsonl')) out.push(path.join(projectDir, f));
      }
    } catch { /* one unreadable project dir must not lose the rest */ }
  }
  return out;
}

/**
 * Read from byte_offset to EOF and split into lines. A trailing partial
 * line (no \n) is not consumed; the offset stops at its start so the next
 * scan can complete it.
 *
 * If byte_offset > file size (file truncated/rotated) → restart from 0.
 */
export async function defaultReadIncremental(filePath, byteOffset) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    let start = byteOffset;
    if (start > stat.size) start = 0;  // file truncated
    const length = stat.size - start;
    if (length <= 0) return { lines: [], nextOffset: start };

    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    const text = buf.toString('utf8');

    const endsWithNewline = text.endsWith('\n');
    const parts = text.split('\n');
    // Last element: '' means a clean \n ending; otherwise it's a partial line.
    // parts.slice(0, -1) always excludes the last element.
    const lines = parts.slice(0, -1);
    const lastPartial = endsWithNewline ? '' : parts[parts.length - 1];
    const consumed = length - Buffer.byteLength(lastPartial, 'utf8');

    return { lines, nextOffset: start + consumed };
  } finally {
    await handle.close();
  }
}
