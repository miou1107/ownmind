/**
 * shared/scanners/codex.js
 *
 * Codex JSONL adapter — 掃 `~/.codex/sessions/**` + `~/.codex/archived_sessions/**`
 *
 * 關鍵差異 vs Claude Code（spec P5）：
 *   - Token 資料在 `event_msg/token_count`，**不在** response_item（response_item 無 usage）
 *   - Codex 無 native message_id，用 server+client 共用的 codexMessageId() 算 fingerprint
 *   - Model 來自 `turn_context.payload.model`（scanner 維護 currentModel 狀態）
 *   - 禁止 line_offset（檔案 compact/rewrite 會破壞 dedupe）；只用 byte_offset
 *   - 用 `info.last_token_usage` 當該 event 的增量 tokens（不是 total_token_usage）
 *
 * Codex token schema → OwnMind event schema 映射：
 *   input_tokens          = last_token_usage.input_tokens - cached_input_tokens (pure new input)
 *   output_tokens         = last_token_usage.output_tokens
 *   cache_creation_tokens = 0   (Codex 無此概念)
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

      for (const file of allFiles) {
        const sourceKey = `${TOOL}:${file}`;
        const prevOffset = Number(state[sourceKey]?.byte_offset || 0);
        const { lines, nextOffset } = await readIncremental(file, prevOffset);

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

          // turn_context: 更新 currentModel
          if (obj.type === 'turn_context' && obj.payload?.model) {
            currentModel = obj.payload.model;
            continue;
          }

          const event = buildEventFromTokenCount(obj, { sessionId, model: currentModel, sourceFile: file });
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
      // Codex 的 cumulative 從 material.total_cumulative 直接來，不需要 session_cumulative map
      return { events, offsetPatch, cumulativePatch: {}, heartbeat };
    }
  };
}

// ────────────────────────────────────────────────────────────
// Helpers（純函式）
// ────────────────────────────────────────────────────────────

export function extractSessionId(filePath) {
  const m = path.basename(filePath).match(FILENAME_UUID_RE);
  return m ? m[1] : null;
}

/**
 * 把 Codex event_msg/token_count 的原始 line 轉成 OwnMind event。
 * 不符合（非 token_count / 缺 info / 缺 last_token_usage）→ 回 null。
 */
export function buildEventFromTokenCount(obj, { sessionId, model, sourceFile }) {
  if (!obj || obj.type !== 'event_msg') return null;
  if (obj.payload?.type !== 'token_count') return null;

  const info = obj.payload?.info;
  if (!info) return null;  // null info = 無統計（如 rate_limits-only）

  const last = info.last_token_usage;
  const total = info.total_token_usage;
  if (!last || !total) return null;

  const ts = obj.timestamp;
  if (!ts || Number.isNaN(new Date(ts).getTime())) return null;

  // Codex input_tokens 包含 cached；pure new = input - cached
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
 * 遞迴列出 baseDir 底下所有 .jsonl
 * Codex 依 yyyy/mm/dd 分目錄存，要遞迴。
 */
async function defaultListJsonlFilesRecursive(baseDir) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }  // 不存在或無權限：乾淨環境跳過
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  await walk(baseDir);
  return out;
}
