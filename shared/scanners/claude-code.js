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

// One fs read hands node a length that its binding CHECKs is an int32; anything
// at or above 2 GiB fails that CHECK and aborts the process, so reads are split.
// 8 MiB is large enough that a normal file is one or two reads.
export const READ_CHUNK_BYTES = 8 * 1024 * 1024;

// How much of one file a single scan will take. Three separate ceilings sit above
// this and all of them are hit before the file is: a buffer that big is a real
// memory spike, `buf.toString()` throws past node's max string length (~512 MiB),
// and the resulting upload would be refused. Past the cap the scan stops on a line
// boundary and the next one continues from there, so a large backlog drains over
// successive runs instead of failing forever at the same byte.
export const MAX_BYTES_PER_SCAN = 64 * 1024 * 1024;

/**
 * Read from byte_offset and split into lines. A trailing partial line (no \n) is
 * not consumed; the offset stops at its start so the next scan can complete it.
 * At most MAX_BYTES_PER_SCAN bytes are taken per call.
 *
 * If byte_offset > file size (file truncated/rotated) → restart from 0.
 *
 * @param {string} filePath
 * @param {number} byteOffset            where the last scan stopped
 * @param {object} [opts]
 * @param {number} [opts.chunkBytes]     max bytes per underlying fs read
 * @param {number} [opts.maxBytes]       max bytes consumed by this call
 * @param {Function} [opts.spy]          test seam: called with each read length
 */
export async function defaultReadIncremental(filePath, byteOffset, opts = {}) {
  const chunkBytes = opts.chunkBytes || READ_CHUNK_BYTES;
  const maxBytes = opts.maxBytes || MAX_BYTES_PER_SCAN;

  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();

    // A stored offset that is not a non-negative whole number is unusable. It used
    // to flow straight into Buffer.alloc / fs.read as NaN; restarting the file is
    // both recoverable and honest — dedupe on the server drops the replayed events.
    const requested = Number(byteOffset);
    let start = Number.isSafeInteger(requested) && requested >= 0 ? requested : 0;
    if (start > stat.size) start = 0;  // file truncated
    const available = stat.size - start;
    if (available <= 0) return { lines: [], nextOffset: start };

    const budget = Math.min(available, maxBytes);
    const buf = Buffer.alloc(budget);
    let filled = 0;
    while (filled < budget) {
      const want = Math.min(chunkBytes, budget - filled);
      opts.spy?.(want);
      const { bytesRead } = await handle.read(buf, filled, want, start + filled);
      if (bytesRead === 0) break;  // file shrank under us; use what we have
      filled += bytesRead;
    }

    // The cut is found in the bytes, not in the decoded string. Once a read can stop
    // at an arbitrary byte, the cut lands inside a multi-byte character sooner or
    // later; decoding first turns those bytes into one U+FFFD, whose own encoded
    // length is 3, and the offset arithmetic silently drifts. The last \n cannot be
    // part of any multi-byte sequence, so it is the one landmark that stays exact.
    const lastNewline = filled > 0 ? buf.lastIndexOf(0x0a, filled - 1) : -1;
    const consumed = lastNewline + 1;
    const text = buf.toString('utf8', 0, consumed);
    // Trailing '' from the final \n; everything before it is a complete line.
    const lines = consumed > 0 ? text.split('\n').slice(0, -1) : [];

    // Stopped at the cap without reaching the end of a single line: consuming 0
    // bytes would return the same nothing on every future scan, so the file would
    // stall in silence. Say so instead — the caller skips this one file, logs its
    // code, and the rest of the scan still runs.
    if (consumed <= 0 && filled >= budget && budget < available) {
      const err = new Error(
        `line exceeds ${maxBytes} bytes at offset ${start} in ${filePath}`,
      );
      err.code = 'OWNMIND_LINE_TOO_LONG';
      throw err;
    }

    return { lines, nextOffset: start + consumed };
  } finally {
    await handle.close();
  }
}
