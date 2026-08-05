/**
 * shared/scanners/codex.js
 *
 * Codex JSONL adapter — scans `~/.codex/sessions/**` plus
 * `~/.codex/archived_sessions/**`.
 *
 * Key differences vs Claude Code (spec P5):
 *   - Token data lives in `event_msg/token_count`, NOT in response_item
 *     (response_item has no usage).
 *   - Codex has no native message_id; the fingerprint is computed via the
 *     shared codexMessageId() used by both client and server.
 *   - Model comes from `turn_context.payload.model` (the scanner tracks
 *     currentModel as state).
 *   - No line_offset (file compact/rewrite would break dedupe); byte_offset only.
 *   - Per-event delta tokens come from `info.last_token_usage` (NOT
 *     total_token_usage).
 *
 * Codex token schema → OwnMind event schema mapping:
 *   input_tokens          = last_token_usage.input_tokens - cached_input_tokens (pure new input)
 *   output_tokens         = last_token_usage.output_tokens
 *   cache_creation_tokens = 0   (Codex has no such concept)
 *   cache_read_tokens     = last_token_usage.cached_input_tokens
 *   reasoning_tokens      = last_token_usage.reasoning_output_tokens
 *   cumulative_total_tokens = total_token_usage.total_tokens
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { defaultReadIncremental } from './claude-code.js';
import { canonicalizeCodexMaterial, codexMessageId } from './id-helper.js';

const DEFAULT_BASE_DIRS = [
  path.join(os.homedir(), '.codex', 'sessions'),
  path.join(os.homedir(), '.codex', 'archived_sessions')
];
const TOOL = 'codex';
const FILENAME_UUID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export function createCodexAdapter({
  baseDirs = DEFAULT_BASE_DIRS,
  scannerVersion = 'unknown',
  machine = os.hostname(),
  listFiles = defaultListJsonlFilesRecursive,
  readIncremental = defaultReadIncremental,
  logger = null
} = {}) {
  return {
    tool: TOOL,

    async readSince(state) {
      const allFiles = [];
      for (const base of baseDirs) {
        const files = await listFiles(base);
        for (const f of files) allFiles.push(f);
      }

      const events = [];
      const offsetPatch = {};
      const skipped = [];

      for (const file of allFiles) {
        const sourceKey = `${TOOL}:${file}`;
        const prevOffset = Number(state[sourceKey]?.byte_offset || 0);

        // v1.26.65 — this call used to sit bare in the loop, so one file that could
        // not be opened ended the scan for the whole tool and took the heartbeat
        // with it, since the heartbeat is built after the loop.
        //
        // Codex triggers this routinely: it moves sessions from ~/.codex/sessions to
        // ~/.codex/archived_sessions and this adapter walks both, so a file archived
        // between the listing and the open is an ENOENT on a path that existed a
        // moment earlier. On the server that showed up as a member with no `codex`
        // heartbeat row at all, which nothing was reading.
        let lines, nextOffset;
        try {
          ({ lines, nextOffset } = await readIncremental(file, prevOffset));
        } catch (err) {
          // `err` is not guaranteed to be an Error: a thrown string has no
          // .message, and logging it raw prints the word "undefined" where the
          // reason should be.
          skipped.push(err?.code || 'UNKNOWN');
          logger?.warn?.(`[codex scanner] skipped ${file}: ${err?.message || String(err)}`);
          continue;
        }

        const sessionId = extractSessionId(file);
        if (!sessionId) {
          logger?.warn?.(`[codex scanner] cannot extract session_id from ${file}`);
          continue;
        }

        let currentModel = state[sourceKey]?.model ?? null;

        for (const line of lines) {
          let obj;
          try { obj = JSON.parse(line); }
          catch (err) {
            logger?.warn?.(`[codex scanner] malformed JSONL (${file}, len=${line.length}): ${err.message}`);
            continue;
          }

          // turn_context: refresh currentModel.
          if (obj.type === 'turn_context' && obj.payload?.model) {
            currentModel = obj.payload.model;
            continue;
          }

          // v1.26.65 — this call used to sit bare, two lines below a `try` that already
          // catches a malformed JSON line and skips it. buildEventFromTokenCount reaches
          // canonicalizeCodexMaterial, which throws on any non-finite number, so a single
          // bad `token_count` line ended the scan for the whole tool — including its
          // heartbeat, which is built after the loop.
          //
          // That is deterministic: the same line fails on every run, forever. It matches
          // a member on production whose `codex` row has never once existed, where the
          // intermittent archival race would have let a check-in through eventually.
          //
          // The file offset still advances past the bad line, so it is stepped over once
          // rather than re-tried until the end of time.
          let event;
          try {
            event = buildEventFromTokenCount(obj, { sessionId, model: currentModel, sourceFile: file });
          } catch (err) {
            skipped.push('BADLINE');
            logger?.warn?.(`[codex scanner] unusable token_count in ${file}: ${err?.message || String(err)}`);
            continue;
          }
          if (event) events.push(event);
        }

        if (nextOffset !== prevOffset || currentModel !== state[sourceKey]?.model) {
          offsetPatch[sourceKey] = {
            byte_offset: nextOffset,
            model: currentModel,
            last_scan: new Date().toISOString()
          };
        }
      }

      const heartbeat = { tool: TOOL, scanner_version: scannerVersion, machine };
      // Codex's cumulative comes directly from material.total_cumulative;
      // no session_cumulative map needed.
      return { events, offsetPatch, cumulativePatch: {}, heartbeat,
               scanned: allFiles.length, skipped };
    }
  };
}

// ────────────────────────────────────────────────────────────
// Helpers (pure functions)
// ────────────────────────────────────────────────────────────

export function extractSessionId(filePath) {
  const m = path.basename(filePath).match(FILENAME_UUID_RE);
  return m ? m[1] : null;
}

/**
 * Turn a raw Codex event_msg/token_count line into an OwnMind event.
 * Mismatches (not token_count / missing info / missing last_token_usage)
 * return null.
 */
export function buildEventFromTokenCount(obj, { sessionId, model, sourceFile }) {
  if (!obj || obj.type !== 'event_msg') return null;
  if (obj.payload?.type !== 'token_count') return null;

  const info = obj.payload?.info;
  if (!info) return null;  // null info = no stats (e.g. rate_limits-only)

  const last = info.last_token_usage;
  const total = info.total_token_usage;
  if (!last || !total) return null;

  const ts = obj.timestamp;
  if (!ts || Number.isNaN(new Date(ts).getTime())) return null;

  // Codex input_tokens includes cached; pure new = input - cached.
  const codexInputRaw = Number(last.input_tokens || 0);
  const codexCached = Number(last.cached_input_tokens || 0);
  const pureInput = Math.max(0, codexInputRaw - codexCached);
  const output = Number(last.output_tokens || 0);
  const reasoning = Number(last.reasoning_output_tokens || 0);
  const cacheRead = codexCached;
  const cacheCreation = 0;

  const material = canonicalizeCodexMaterial({
    ts_iso: ts,
    total_cumulative: Number(total.total_tokens || 0),
    last_total: Number(last.total_tokens || 0),
    input: pureInput,
    output,
    cache_creation: cacheCreation,
    cache_read: cacheRead,
    reasoning
  });

  const messageId = codexMessageId(sessionId, material);

  return {
    tool: TOOL,
    session_id: sessionId,
    message_id: messageId,
    model: model ?? null,
    ts,
    input_tokens: pureInput,
    output_tokens: output,
    cache_creation_tokens: cacheCreation,
    cache_read_tokens: cacheRead,
    reasoning_tokens: reasoning,
    cumulative_total_tokens: material.total_cumulative,
    codex_fingerprint_material: material,
    source_file: path.basename(sourceFile)
  };
}

/**
 * Recursively list all .jsonl files under baseDir.
 * Codex stores them in yyyy/mm/dd subdirectories, so recursion is required.
 */
async function defaultListJsonlFilesRecursive(baseDir) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }  // missing or unreadable: clean env, skip
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  await walk(baseDir);
  return out;
}
