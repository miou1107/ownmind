/**
 * Session counter — used by reply-lint's v1.19.3 gradual block.
 *
 * Corresponds to openspec/changes/v1.19.3-reply-lint-progressive-block/spec.md scenarios 7 / 8 / 14.
 *
 * Why this exists:
 *   The reply-lint hook escalated from "warn-only" to "gradual block": first 2 violations are
 *   warnings, the 3rd is a pre-announce, the 4th writes the block JSON. We need to track how many
 *   violations have accumulated within each Claude session.
 *
 * Design principles:
 *   - Pure file-based (no DB / server dependency — the hook can use it immediately, locally).
 *   - Fail-soft (corruption / no permission → treat as 0; never block the hook flow).
 *   - Auto-sweep sessions older than 30 days (keep the file bounded).
 *   - Pure-function style for testability (_resetCounterPathForTests is for tests, prod doesn't call it).
 *
 * Schema:
 *   {
 *     "<session_id>": {
 *       "count": <int>,                       // cumulative violation count (decides when to block)
 *       "block_count": <int>,                 // v1.19.7: cumulative block count (decides when to downgrade)
 *       "last_violation_ts": "<ISO8601>",
 *       "started_at": "<ISO8601>"
 *     }
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_COUNTER_PATH = path.join(
  os.homedir(),
  '.ownmind',
  'logs',
  'reply-lint-session-counter.json'
);

let counterPath = DEFAULT_COUNTER_PATH;

/**
 * For tests: override the counter file path, or pass null to restore the default.
 * Production code MUST NOT call this.
 */
export function _resetCounterPathForTests(p) {
  counterPath = p || DEFAULT_COUNTER_PATH;
}

function readAll() {
  try {
    if (!fs.existsSync(counterPath)) return {};
    const raw = fs.readFileSync(counterPath, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    // Corruption / no permission / any IO error → treat as empty; subsequent writes overwrite cleanly.
    return {};
  }
}

function writeAll(data) {
  try {
    fs.mkdirSync(path.dirname(counterPath), { recursive: true });
    fs.writeFileSync(counterPath, JSON.stringify(data, null, 2));
    return true;
  } catch {
    // No permission / disk full → swallow; the hook still proceeds (count just doesn't accumulate).
    return false;
  }
}

/**
 * Read the current count for a session; returns 0 if the file is missing or corrupt.
 */
export function readCounter(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return 0;
  const all = readAll();
  return all[sessionId]?.count || 0;
}

/**
 * Increment a session's counter by 1 and return the new value.
 * On write failure (no permission / disk full), do not throw; return 1 (treat as "this turn
 * violated; next read sees 0 again").
 */
export function incrementCounter(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return 0;
  const all = readAll();
  const nowIso = new Date().toISOString();
  const existing = all[sessionId];
  if (existing && typeof existing.count === 'number') {
    existing.count += 1;
    existing.last_violation_ts = nowIso;
  } else {
    all[sessionId] = {
      count: 1,
      last_violation_ts: nowIso,
      started_at: nowIso,
    };
  }
  writeAll(all);
  return all[sessionId].count;
}

/**
 * v1.19.7: read the block count for a session; returns 0 if file missing or corrupt.
 *
 * Block count is independent of violation count:
 *   - violation count: must hit threshold before entering the block state.
 *   - block_count: actual number of times we've blocked the AI for rewrite; at 3 we downgrade
 *     to warning (loop protection).
 */
export function readBlockCount(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return 0;
  const all = readAll();
  return all[sessionId]?.block_count || 0;
}

/**
 * v1.19.7: increment a session's block count by 1 and return the new value.
 *
 * On write failure (no permission), do not throw; return 1 (treat as "this turn blocked; next
 * read sees 0 again"). If no session record exists, create one.
 */
export function incrementBlockCount(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return 0;
  const all = readAll();
  const nowIso = new Date().toISOString();
  const existing = all[sessionId];
  if (existing && typeof existing === 'object') {
    existing.block_count = (typeof existing.block_count === 'number' ? existing.block_count : 0) + 1;
    existing.last_block_ts = nowIso;
    if (typeof existing.count !== 'number') existing.count = 0;
    if (!existing.started_at) existing.started_at = nowIso;
  } else {
    all[sessionId] = {
      count: 0,
      block_count: 1,
      last_block_ts: nowIso,
      started_at: nowIso,
    };
  }
  writeAll(all);
  return all[sessionId].block_count;
}

/**
 * v1.19.7: reset a session's block count to 0 (does not touch violation count).
 *
 * Trigger: called when reply-lint passes, to prevent stale cross-turn counts from incorrectly
 * triggering the downgrade.
 * Never throws: no session record → noop.
 */
export function resetBlockCount(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return;
  const all = readAll();
  const existing = all[sessionId];
  if (!existing || typeof existing !== 'object') return;
  if (!existing.block_count) return;
  existing.block_count = 0;
  writeAll(all);
}

/**
 * Sweep session records whose started_at is older than maxAgeMs.
 * Never throws (missing / corrupt file → noop).
 */
export function cleanupStale(maxAgeMs) {
  const all = readAll();
  if (Object.keys(all).length === 0) return;
  const cutoff = Date.now() - maxAgeMs;
  let changed = false;
  for (const [sid, entry] of Object.entries(all)) {
    const started = Date.parse(entry?.started_at || '');
    if (!Number.isFinite(started) || started < cutoff) {
      delete all[sid];
      changed = true;
    }
  }
  if (changed) writeAll(all);
}
