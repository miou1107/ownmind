/**
 * shared/scanners/base.js
 *
 * Scanner orchestrator — 所有 IDE adapter 共用同一條流程（spec S4 D11）：
 *   1. 讀取 offset 檔（不存在 = 從 0 開始，無 first-run 分支）
 *   2. adapter.readSince(state) → { events, offsetPatch, cumulativePatch, heartbeat }
 *   3. 分批 POST /api/usage/events（每批 500）
 *   4. 任何批次失敗 → throw，不更新 offset；server UNIQUE 做 dedupe，重送安全
 *   5. 所有批次成功 → atomic rename 寫回新 offsets + cumulative
 *
 * 失敗模式：events 已入 server 但 offset 沒推進 → 下次重跑，重複事件被 UNIQUE 擋，
 *           session_cumulative 重新累加。保證 「server 擁有 ≥ 本地 offset 以前所有 events」。
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export const DEFAULT_CACHE_PATH = path.join(
  os.homedir(), '.ownmind', 'cache', 'scanner-offsets.json'
);
export const BATCH_SIZE = 500;
export const POST_TIMEOUT_MS = 30_000;

/**
 * 讀取 offset 檔；不存在或損毀時回傳 {}
 */
export async function readOffsets(cachePath = DEFAULT_CACHE_PATH) {
  try {
    const s = await fs.readFile(cachePath, 'utf8');
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * 原子化寫入：先寫 tmp、再 rename。
 * 若中途 crash，原檔不變；rename 是 POSIX 原子操作。
 */
export async function writeOffsetsAtomic(cachePath, offsets) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(offsets, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, cachePath);
}

export function chunk(arr, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * POST /api/usage/events — 失敗 throw。
 * 可注入 fetchFn 方便測試。
 */
export async function postBatch({ apiUrl, apiKey, fetchFn = fetch, timeoutMs = POST_TIMEOUT_MS }, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${apiUrl.replace(/\/+$/, '')}/api/usage/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST /api/usage/events ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 單一 adapter 的完整 scan → post → commit-offset 流程。
 *
 * @param {object} deps
 * @param {object} deps.adapter - 要有 tool + readSince(state)
 * @param {string} deps.apiUrl
 * @param {string} deps.apiKey
 * @param {string} [deps.cachePath]
 * @param {Function} [deps.fetchFn]
 * @param {object} [deps.logger]
 */
export async function runScan(deps) {
  const {
    adapter, apiUrl, apiKey,
    cachePath = DEFAULT_CACHE_PATH,
    fetchFn = fetch,
    logger = console
  } = deps;

  const state = await readOffsets(cachePath);
  const {
    events, offsetPatch, cumulativePatch, heartbeat,
    sessions = []        // Tier 2 adapters 會帶；Tier 1 預設空
  } = await adapter.readSince(state);

  // 空 scan：送 heartbeat + 任何 sessions
  if (events.length === 0) {
    if (heartbeat || sessions.length > 0) {
      const payload = { events: [], heartbeat };
      if (sessions.length > 0) payload.sessions = sessions;
      await postBatch({ apiUrl, apiKey, fetchFn }, payload);
    }
    // 仍需原子寫回 offset（Tier 2 session_date 可能推進）
    if (Object.keys(offsetPatch).length > 0) {
      const newState = mergeState(state, adapter.tool, offsetPatch, cumulativePatch);
      await writeOffsetsAtomic(cachePath, newState);
    }
    return {
      tool: adapter.tool, sent: 0, batches: 0, accepted: 0, duplicated: 0,
      sessions: sessions.length
    };
  }

  const batches = chunk(events, BATCH_SIZE);
  let accepted = 0;
  let duplicated = 0;

  for (let i = 0; i < batches.length; i += 1) {
    const isLast = i === batches.length - 1;
    const payload = { events: batches[i] };
    if (isLast && heartbeat) payload.heartbeat = heartbeat;
    if (isLast && sessions.length > 0) payload.sessions = sessions;

    const resp = await postBatch({ apiUrl, apiKey, fetchFn }, payload);
    accepted += Number(resp.accepted ?? 0);
    duplicated += Number(resp.duplicated ?? 0);
    logger.info?.(`[scanner] ${adapter.tool} batch ${i + 1}/${batches.length} ` +
      `accepted=${resp.accepted} dup=${resp.duplicated} rejected=${resp.rejected?.length || 0}`);
  }

  // 全部 batch 成功 → 合併並原子寫回
  const newState = mergeState(state, adapter.tool, offsetPatch, cumulativePatch);
  await writeOffsetsAtomic(cachePath, newState);

  return {
    tool: adapter.tool,
    sent: events.length,
    batches: batches.length,
    accepted, duplicated,
    sessions: sessions.length
  };
}

/**
 * 合併 offset + session_cumulative 到 state。純函式。
 */
export function mergeState(state, tool, offsetPatch = {}, cumulativePatch = {}) {
  const next = { ...state };
  for (const [k, v] of Object.entries(offsetPatch)) next[k] = v;
  const existing = state.session_cumulative?.[tool] || {};
  next.session_cumulative = {
    ...(state.session_cumulative || {}),
    [tool]: { ...existing, ...cumulativePatch }
  };
  return next;
}
