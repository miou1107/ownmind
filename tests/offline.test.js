import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 用暫存目錄隔離測試
const TEST_DIR = path.join(os.tmpdir(), 'ownmind-test-' + Date.now());
const CACHE_PATH = path.join(TEST_DIR, 'cache/memories.json');
const QUEUE_PATH = path.join(TEST_DIR, 'queue.jsonl');

// 讓 offline.js 可以接受自訂路徑
import { makeOfflineHelpers } from '../mcp/offline.js';
const { isNetworkError, readMemoryCache, writeMemoryCache, localSearch, enqueueOperation, readQueue, clearQueue } = makeOfflineHelpers(CACHE_PATH, QUEUE_PATH);

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
  const cache = {
    saved_at: '2026-04-01T00:00:00Z',
    data: {
      iron_rule: [{ id: 1, title: 'SSH 不要頻繁登入', content: '一次 session 完成所有工作' }],
      profile: [{ id: 2, title: 'Vin 個人偏好', content: '台北時間 UTC+8' }],
    }
  };
  it('matches by title', () => {
    const results = localSearch(cache, 'SSH');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 1);
  });
  it('matches by content', () => {
    const results = localSearch(cache, 'UTC+8');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 2);
  });
  it('case-insensitive', () => {
    const results = localSearch(cache, 'ssh');
    assert.equal(results.length, 1);
  });
  it('no match returns empty array', () => {
    const results = localSearch(cache, 'nonexistent_xyz');
    assert.equal(results.length, 0);
  });
  it('returns empty array if cache is null', () => {
    assert.deepEqual(localSearch(null, 'anything'), []);
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-replay-'));
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
    assert.ok(result.message.includes('完成'));
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
    assert.ok(result.message.includes('部分失敗'));
    assert.equal(helpers.readQueue().length, 2);
  });
});
