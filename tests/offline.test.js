import { describe, it, before, after } from 'node:test';
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
