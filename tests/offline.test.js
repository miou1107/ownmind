import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the test with a temporary directory
const TEST_DIR = path.join(os.tmpdir(), 'ownmind-test-' + Date.now());
const CACHE_PATH = path.join(TEST_DIR, 'cache/memories.json');
const QUEUE_PATH = path.join(TEST_DIR, 'queue.jsonl');

// Let offline.js accept custom paths
import { makeOfflineHelpers } from '../mcp/offline.js';
import { tempDir } from './helpers/temp-dir.js';
const { isNetworkError, readMemoryCache, writeMemoryCache, localSearch, findCachedMemory, enqueueOperation, readQueue, clearQueue } = makeOfflineHelpers(CACHE_PATH, QUEUE_PATH);

before(() => fs.mkdirSync(path.join(TEST_DIR, 'cache'), { recursive: true }));
after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

describe('isNetworkError', () => {
  it('ECONNREFUSED is network error', () => {
    const err = new Error('connect ECONNREFUSED');
    err.code = 'ECONNREFUSED';
    assert.equal(isNetworkError(err), true);
  });
  it('ETIMEDOUT is network error', () => {
    const err = new Error('connect ETIMEDOUT');
    err.code = 'ETIMEDOUT';
    assert.equal(isNetworkError(err), true);
  });
  it('fetch failed is network error', () => {
    assert.equal(isNetworkError(new Error('fetch failed')), true);
  });
  it('EHOSTUNREACH is network error', () => {
    const err = new Error('no route to host');
    err.code = 'EHOSTUNREACH';
    assert.equal(isNetworkError(err), true);
  });
  it('ENETUNREACH is network error', () => {
    const err = new Error('network unreachable');
    err.code = 'ENETUNREACH';
    assert.equal(isNetworkError(err), true);
  });
  it('API 400 is NOT network error', () => {
    assert.equal(isNetworkError(new Error('API 400: bad request')), false);
  });
  it('API 500 is NOT network error', () => {
    assert.equal(isNetworkError(new Error('API 500: server error')), false);
  });
});

describe('readMemoryCache / writeMemoryCache', () => {
  it('returns null when no cache file', () => {
    assert.equal(readMemoryCache(), null);
  });
  it('writes and reads back', () => {
    const payload = { saved_at: '2026-04-01T00:00:00Z', data: { iron_rule: [{ id: 1 }] } };
    writeMemoryCache(payload);
    const result = readMemoryCache();
    assert.deepEqual(result, payload);
  });
});

describe('localSearch', () => {
  // v1.26.64 — localSearch answers `{ data, total, returned }` now, shaped by the same
  // shared function as the online route, so the offline path cannot blow the caller's
  // output ceiling either. These cases are about *matching*, which did not change, so
  // they reach through .data rather than being rewritten.
  const rows = (cacheArg, q) => localSearch(cacheArg, q).data;
  const cache = {
    saved_at: '2026-04-01T00:00:00Z',
    data: {
      iron_rule: [{ id: 1, title: 'SSH 不要頻繁登入', content: '一次 session 完成所有工作' }],
      profile: [{ id: 2, title: 'Vin 個人偏好', content: '台北時間 UTC+8' }],
    }
  };
  it('matches by title', () => {
    const results = rows(cache, 'SSH');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 1);
  });
  it('matches by content', () => {
    const results = rows(cache, 'UTC+8');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 2);
  });
  it('case-insensitive', () => {
    const results = rows(cache, 'ssh');
    assert.equal(results.length, 1);
  });
  it('no match returns empty array', () => {
    const results = rows(cache, 'nonexistent_xyz');
    assert.equal(results.length, 0);
  });
  it('returns empty array if cache is null', () => {
    assert.deepEqual(localSearch(null, 'anything'), { data: [], total: 0, returned: 0 });
  });

  // v1.26.37 — parity with the online /search rewrite (Bug #7). Offline used to
  // do title|content substring only; now it tokenizes + ANDs + matches title /
  // content / code / tags.
  it('v1.26.37 — matches by tag element', () => {
    const c = {
      data: { project: [{ id: 10, title: 'unrelated', content: 'unrelated',
                          tags: ['deploy', 'kkvin'] }] },
    };
    assert.equal(rows(c, 'kkvin').length, 1);
    assert.equal(rows(c, 'kkvin').length, 1);
  });

  it('v1.26.37 — matches by code column', () => {
    const c = {
      data: { iron_rule: [{ id: 11, title: 't', content: 'c', code: 'IR-042' }] },
    };
    assert.equal(rows(c, 'IR-042').length, 1);
  });

  it('v1.26.37 — multi-token ANDs across fields', () => {
    const c = {
      data: {
        iron_rule: [
          { id: 20, title: 'iron rule about deploy', content: 'body' },
          { id: 21, title: 'iron rule', content: 'body without the second term' },
        ],
      },
    };
    const hits = rows(c, 'iron deploy');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 20);
  });

  it('v1.26.37 — empty / single-char-only query returns empty', () => {
    const c = { data: { iron_rule: [{ id: 30, title: 'anything', content: 'x' }] } };
    const empty = { data: [], total: 0, returned: 0 };
    assert.deepEqual(localSearch(c, ''), empty);
    assert.deepEqual(localSearch(c, '   '), empty);
    assert.deepEqual(localSearch(c, 'a b'), empty);
  });
});

describe('enqueueOperation / readQueue / clearQueue', () => {
  it('enqueue and read back', () => {
    enqueueOperation({ method: 'POST', path: '/api/memory', body: { title: 'test' } });
    const queue = readQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].method, 'POST');
    assert.ok(queue[0].queued_at);
  });
  it('enqueue multiple preserves order', () => {
    enqueueOperation({ method: 'PUT', path: '/api/memory/1', body: {} });
    const queue = readQueue();
    assert.equal(queue.length, 2);
    assert.equal(queue[1].method, 'PUT');
  });
  it('clearQueue removes file', () => {
    clearQueue();
    const queue = readQueue();
    assert.equal(queue.length, 0);
  });
});

describe('replayQueue', () => {
  let helpers;
  let tmpDir;

  beforeEach(() => {
    tmpDir = tempDir('ownmind-replay-');
    helpers = makeOfflineHelpers(
      path.join(tmpDir, 'memories.json'),
      path.join(tmpDir, 'queue.jsonl')
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('empty queue → returns replayed:0, message:null', async () => {
    const result = await helpers.replayQueue(async () => {}, 'tok');
    assert.equal(result.replayed, 0);
    assert.equal(result.remaining, 0);
    assert.equal(result.message, null);
  });

  it('all succeed → clears queue, returns done message', async () => {
    helpers.enqueueOperation({ method: 'POST', path: '/api/memory', body: { title: 'a' } });
    helpers.enqueueOperation({ method: 'POST', path: '/api/memory', body: { title: 'b' } });

    const calls = [];
    const result = await helpers.replayQueue(async (method, path, body) => {
      calls.push({ method, path, body });
    }, 'new-token');

    assert.equal(result.replayed, 2);
    assert.equal(result.remaining, 0);
    assert.ok(/complete|完成/i.test(result.message));
    assert.equal(helpers.readQueue().length, 0);
  });

  it('replayed body uses currentSyncToken, not stale queued token', async () => {
    helpers.enqueueOperation({ method: 'POST', path: '/api/memory', body: { title: 'x', sync_token: 'old-token' } });

    const captured = [];
    await helpers.replayQueue(async (method, path, body) => {
      captured.push(body);
    }, 'fresh-token');

    assert.equal(captured[0].sync_token, 'fresh-token');
  });

  it('partial failure → keeps remaining in queue, returns partial message', async () => {
    helpers.enqueueOperation({ method: 'POST', path: '/api/memory', body: { title: 'ok' } });
    helpers.enqueueOperation({ method: 'POST', path: '/api/memory', body: { title: 'fail' } });
    helpers.enqueueOperation({ method: 'POST', path: '/api/memory', body: { title: 'never' } });

    let callCount = 0;
    const result = await helpers.replayQueue(async () => {
      callCount++;
      if (callCount === 2) throw new Error('network error');
    }, 'tok');

    assert.equal(result.replayed, 1);
    assert.equal(result.remaining, 2);
    assert.ok(/partially failed/i.test(result.message));
    assert.equal(helpers.readQueue().length, 2);
  });
});

describe('findCachedMemory', () => {
  // v1.26.64 — the offline half of "read one search result in full". Review caught that
  // the online ownmind_get(id) branch had no offline fallback at all, unlike every other
  // branch of that tool: it would have thrown instead of degrading.
  const cache = {
    data: {
      iron_rule: [{ id: 1, title: 'a', content: 'x'.repeat(3000) }],
      project: [{ id: 692, title: 'multi-claude-switcher', content: 'long body' }],
    },
  };

  it('finds a memory across type buckets', () => {
    assert.equal(findCachedMemory(cache, 692).title, 'multi-claude-switcher');
  });

  it('returns the whole memory, not a preview — that is the point of the follow-up', () => {
    assert.equal(findCachedMemory(cache, 1).content.length, 3000);
  });

  it('matches a numeric id given as a string, since tool arguments arrive as strings', () => {
    assert.equal(findCachedMemory(cache, '692').id, 692);
  });

  it('returns null rather than throwing for a miss or a bad cache', () => {
    assert.equal(findCachedMemory(cache, 99999), null);
    assert.equal(findCachedMemory(null, 1), null);
    assert.equal(findCachedMemory({ data: null }, 1), null);
    assert.equal(findCachedMemory(cache, ''), null);
    assert.equal(findCachedMemory(cache, undefined), null);
  });
});
