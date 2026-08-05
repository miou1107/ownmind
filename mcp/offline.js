import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { tokenize, itemMatchesTokens } from '../shared/memory-search-tokens.js';
import { shapeSearchResults } from '../shared/memory-search-result.js';

const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.ownmind/cache/memories.json');
const DEFAULT_QUEUE_PATH = path.join(os.homedir(), '.ownmind/queue.jsonl');

export function makeOfflineHelpers(cachePath = DEFAULT_CACHE_PATH, queuePath = DEFAULT_QUEUE_PATH) {

  function isNetworkError(err) {
    if (!err) return false;
    const msg = err.message || '';
    const code = err.code || '';
    return (
      code === 'EHOSTUNREACH' ||
      code === 'ENETUNREACH' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      code === 'ECONNRESET' ||
      msg.toLowerCase().includes('fetch failed') ||
      msg.toLowerCase().includes('network error')
    );
  }

  function readMemoryCache() {
    try {
      if (!fs.existsSync(cachePath)) return null;
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      return null;
    }
  }

  function writeMemoryCache(payload) {
    try {
      const dir = path.dirname(cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2));
    } catch { /* silent fail */ }
  }

  // v1.26.64 — the offline half of "read one result in full". Search hands back
  // previews, so the follow-up fetch must work on both paths; the cache already holds
  // whole memories, so this is a lookup rather than a new capability.
  function findCachedMemory(cache, id) {
    if (!cache?.data || id === undefined || id === null || id === '') return null;
    const wanted = String(id);
    for (const items of Object.values(cache.data)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item && String(item.id) === wanted) return item;
      }
    }
    return null;
  }

  // v1.26.37 (Bug #7 fix): shares tokenize + itemMatchesTokens with the online
  // /search path so offline and online return the same shape of hits (multi-
  // token AND, matches title / content / code / tags). Pre-v1.26.37 this did a
  // single lowercased `.includes()` over title|content only.
  //
  // v1.26.64 — shaped and capped through the same shared function as the online route.
  // The cache holds whole memories, so an unbounded match here blows the caller's output
  // ceiling exactly as the server did before Bug #11 was fixed. Returning
  // `{data, total, returned}` also means an AI cannot tell which path answered it, apart
  // from the offline notice, which is the point of putting the shaping in shared/.
  function localSearch(cache, query) {
    if (!cache?.data) return shapeSearchResults([]);
    const tokens = tokenize(query);
    if (tokens.length === 0) return shapeSearchResults([]);
    const results = [];
    for (const items of Object.values(cache.data)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (itemMatchesTokens(item, tokens)) results.push(item);
      }
    }
    return shapeSearchResults(results);
  }

  function enqueueOperation(op) {
    try {
      const dir = path.dirname(queuePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const entry = JSON.stringify({ ...op, queued_at: new Date().toISOString() });
      fs.appendFileSync(queuePath, entry + '\n');
    } catch { /* silent fail */ }
  }

  function readQueue() {
    try {
      if (!fs.existsSync(queuePath)) return [];
      return fs.readFileSync(queuePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function clearQueue() {
    try {
      if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath);
    } catch { /* silent fail */ }
  }

  async function replayQueue(callApi, currentSyncToken) {
    const ops = readQueue();
    if (ops.length === 0) return { replayed: 0, remaining: 0, message: null };

    let replayed = 0;
    for (const op of ops) {
      try {
        const replayBody = op.body ? { ...op.body, sync_token: currentSyncToken } : undefined;
        await callApi(op.method, op.path, replayBody);
        replayed++;
      } catch {
        const remaining = ops.slice(replayed);
        clearQueue();
        for (const r of remaining) enqueueOperation(r);
        return {
          replayed,
          remaining: remaining.length,
          message: `[OwnMind] Queue replay partially failed — ${replayed} operations sent, ${remaining.length} still pending`,
        };
      }
    }

    clearQueue();
    return {
      replayed,
      remaining: 0,
      message: `[OwnMind] Queue replay complete — ${replayed} operations synced`,
    };
  }

  return { isNetworkError, readMemoryCache, writeMemoryCache, localSearch, findCachedMemory, enqueueOperation, readQueue, clearQueue, replayQueue };
}

// Default export: pre-built instance with production paths
export const {
  isNetworkError,
  readMemoryCache,
  writeMemoryCache,
  localSearch,
  findCachedMemory,
  enqueueOperation,
  readQueue,
  clearQueue,
  replayQueue,
} = makeOfflineHelpers();
