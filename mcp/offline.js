import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

  function localSearch(cache, query) {
    if (!cache?.data) return [];
    const q = query.toLowerCase();
    const results = [];
    for (const items of Object.values(cache.data)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const title = (item.title || '').toLowerCase();
        const content = (item.content || '').toLowerCase();
        if (title.includes(q) || content.includes(q)) {
          results.push(item);
        }
      }
    }
    return results;
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
          message: `【OwnMind】佇列重送部分失敗，已重送 ${replayed} 筆，還剩 ${remaining.length} 筆待送`,
        };
      }
    }

    clearQueue();
    return {
      replayed,
      remaining: 0,
      message: `【OwnMind】佇列重送完成，${replayed} 筆操作已同步`,
    };
  }

  return { isNetworkError, readMemoryCache, writeMemoryCache, localSearch, enqueueOperation, readQueue, clearQueue, replayQueue };
}

// Default export: pre-built instance with production paths
export const {
  isNetworkError,
  readMemoryCache,
  writeMemoryCache,
  localSearch,
  enqueueOperation,
  readQueue,
  clearQueue,
  replayQueue,
} = makeOfflineHelpers();
