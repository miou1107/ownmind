/**
 * shared/scanners/base.js
 *
 * Scanner orchestrator — every IDE adapter shares the same pipeline
 * (spec S4 D11):
 *   1. Read offsets file (missing = start from 0; no first-run branch).
 *   2. adapter.readSince(state) → { events, offsetPatch, cumulativePatch, heartbeat }
 *   3. POST /api/usage/events in batches (500 per batch).
 *   4. Any batch failing → throw, don't advance offsets; the server's UNIQUE
 *      constraint deduplicates and replay is safe.
 *   5. All batches succeed → atomic rename writes the new offsets + cumulative.
 *
 * Failure mode: events landed on the server but the offset didn't advance →
 * next run replays, repeats are blocked by UNIQUE, session_cumulative
 * re-accumulates. Invariant: "the server holds ≥ every event before the
 * local offset."
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
 * Read the offsets file; returns {} when missing or corrupted.
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
 * Atomic write: write to tmp, then rename.
 * On crash mid-write the original file is intact; rename is POSIX-atomic.
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
 * POST /api/usage/events — throws on failure.
 * fetchFn is injectable for tests.
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
 * Full scan → post → commit-offset pipeline for a single adapter.
 *
 * @param {object} deps
 * @param {object} deps.adapter - must have tool + readSince(state)
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
    sessions = []        // Tier 2 adapters supply this; Tier 1 defaults to empty
  } = await adapter.readSince(state);

  // Empty scan: still send heartbeat + any sessions.
  if (events.length === 0) {
    if (heartbeat || sessions.length > 0) {
      const payload = { events: [], heartbeat };
      if (sessions.length > 0) payload.sessions = sessions;
      await postBatch({ apiUrl, apiKey, fetchFn }, payload);
    }
    // Still need to atomic-write offsets (Tier 2 session_date may advance).
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

  // All batches succeeded → merge and atomic write.
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
 * Merge offsetPatch + session_cumulative into state. Pure function.
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
