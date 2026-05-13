import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  shouldRefreshCache,
  fetchSyncTokenLight,
  fetchInitFull,
  readCache,
  writeCache,
  runConditionalSync,
} from '../hooks/lib/conditional-sync.js';

/**
 * v1.18.0 — conditional-sync 測試（spec.md §4.2 + §4.5）
 */

let tmpHome;
let cachePath;

function setup() {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-cond-sync-test-'));
  cachePath = path.join(tmpHome, 'cache', 'memories.json');
}
function cleanup() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

function makeFetch(handlers) {
  return async (url, init) => {
    for (const [pattern, handler] of handlers) {
      if (url.includes(pattern)) {
        return handler(url, init);
      }
    }
    throw new Error(`unmocked: ${url}`);
  };
}

function okJson(body) {
  return { ok: true, status: 200, json: async () => body };
}
function failJson(status = 500) {
  return { ok: false, status, json: async () => ({}) };
}

describe('v1.18.0 — shouldRefreshCache', () => {
  it('cache 不存在 → 必須 refresh', () => {
    assert.equal(shouldRefreshCache(null, 'a1a785218482'), true);
  });

  it('cache 缺 sync_token → refresh', () => {
    assert.equal(shouldRefreshCache({ saved_at: new Date().toISOString() }, 'a1a785218482'), true);
  });

  it('saved_at 超過 24 hr → refresh (即使 token 相同)', () => {
    const ago25h = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    assert.equal(
      shouldRefreshCache({ sync_token: 'X', saved_at: ago25h }, 'X'),
      true,
      '24hr 保險 trump token match'
    );
  });

  it('saved_at 23 hr 內 + token 相同 → 不 refresh', () => {
    const ago23h = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    assert.equal(shouldRefreshCache({ sync_token: 'X', saved_at: ago23h }, 'X'), false);
  });

  it('token 不同 → refresh', () => {
    const recent = new Date().toISOString();
    assert.equal(shouldRefreshCache({ sync_token: 'OLD', saved_at: recent }, 'NEW'), true);
  });

  it('serverSyncToken 是 null → 保守 refresh', () => {
    const recent = new Date().toISOString();
    assert.equal(shouldRefreshCache({ sync_token: 'X', saved_at: recent }, null), true);
  });

  it('saved_at 非法 ISO → refresh', () => {
    assert.equal(shouldRefreshCache({ sync_token: 'X', saved_at: 'invalid' }, 'X'), true);
  });
});

describe('v1.18.0 — fetchSyncTokenLight', () => {
  it('成功 → 回 12-char hex token', async () => {
    const fakeFetch = makeFetch([
      ['/api/memory/sync-token', () => okJson({ sync_token: 'a1a785218482' })],
    ]);
    const t = await fetchSyncTokenLight('http://api', 'KEY', fakeFetch);
    assert.equal(t, 'a1a785218482');
  });

  it('5xx → 回 null', async () => {
    const fakeFetch = makeFetch([['sync-token', () => failJson(500)]]);
    const t = await fetchSyncTokenLight('http://api', 'KEY', fakeFetch);
    assert.equal(t, null);
  });

  it('network error → 回 null (不 throw)', async () => {
    const fakeFetch = async () => { throw new Error('network down'); };
    const t = await fetchSyncTokenLight('http://api', 'KEY', fakeFetch);
    assert.equal(t, null);
  });

  it('缺 apiUrl/apiKey → 回 null', async () => {
    assert.equal(await fetchSyncTokenLight('', 'KEY'), null);
    assert.equal(await fetchSyncTokenLight('http://api', ''), null);
  });

  it('帶 Authorization: Bearer header', async () => {
    let captured = null;
    const fakeFetch = makeFetch([['sync-token', (url, init) => {
      captured = init;
      return okJson({ sync_token: 'X' });
    }]]);
    await fetchSyncTokenLight('http://api', 'mykey', fakeFetch);
    assert.equal(captured.headers.Authorization, 'Bearer mykey');
  });
});

describe('v1.18.0 — fetchInitFull', () => {
  it('成功 → 回完整 init payload', async () => {
    const payload = { sync_token: 'X', data: { iron_rule: [{ id: 1 }] } };
    const fakeFetch = makeFetch([['/api/memory/init', () => okJson(payload)]]);
    const r = await fetchInitFull('http://api', 'K', fakeFetch);
    assert.deepEqual(r, payload);
  });

  it('5xx → null', async () => {
    const fakeFetch = makeFetch([['init', () => failJson(503)]]);
    assert.equal(await fetchInitFull('http://api', 'K', fakeFetch), null);
  });
});

describe('v1.18.0 — readCache / writeCache', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('cache 不存在 → readCache 回 null', () => {
    assert.equal(readCache(cachePath), null);
  });

  it('writeCache 自動建目錄 + 包 sync_token + saved_at', () => {
    const ok = writeCache({ sync_token: 'XYZ', data: { x: 1 } }, cachePath);
    assert.equal(ok, true);
    const c = readCache(cachePath);
    assert.equal(c.sync_token, 'XYZ');
    assert.ok(c.saved_at);
    assert.deepEqual(c.data, { x: 1 });
  });

  it('壞 JSON → readCache 回 null (不 throw)', () => {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, '{ broken json');
    assert.equal(readCache(cachePath), null);
  });
});

describe('v1.18.0 — runConditionalSync 完整流程', () => {
  beforeEach(setup);
  afterEach(cleanup);

  // v1.18.0-rc2 review B1 修正：fixture 改成跟 prod init endpoint 一致的 shape
  // prod init endpoint compact mode 回 { sync_token, server_version, profile,
  //   iron_rules_digest (string), iron_rules_count, ... } — 沒有 iron_rule array
  // (鐵律 list 由 conditional-sync-cli 額外打 /api/memory/sync 拿)
  it('cache fresh + token match → cache_fresh 不 download init', async () => {
    const initShape = {
      sync_token: 'XYZ',
      server_version: '1.18.0',
      iron_rules_digest: 'IR-002\nIR-003',
      iron_rules_count: 2,
      profile: { id: 3, title: '基本偏好', content: '...' },
    };
    writeCache({ sync_token: 'XYZ', data: initShape }, cachePath);
    let initCalled = false;
    const fakeFetch = makeFetch([
      ['sync-token', () => okJson({ sync_token: 'XYZ' })],
      ['init', () => { initCalled = true; return okJson({}); }],
    ]);
    const r = await runConditionalSync({
      apiUrl: 'http://api', apiKey: 'K',
      cachePath, fetchFn: fakeFetch,
    });
    assert.equal(r.source, 'cache_fresh');
    assert.equal(r.refreshed, false);
    assert.equal(initCalled, false, 'token match 不該打 init');
    assert.deepEqual(r.data, initShape);
  });

  it('cache exists + token mismatch → init download + 寫新 cache', async () => {
    writeCache({ sync_token: 'OLD', data: { sync_token: 'OLD' } }, cachePath);
    // init endpoint 回 prod shape (無 iron_rule array、有 iron_rules_digest)
    const newInitShape = {
      sync_token: 'NEW',
      server_version: '1.18.0',
      iron_rules_digest: 'IR-002\nIR-003\nIR-099',
      iron_rules_count: 3,
    };
    const fakeFetch = makeFetch([
      ['sync-token', () => okJson({ sync_token: 'NEW' })],
      ['init', () => okJson(newInitShape)],
    ]);
    const r = await runConditionalSync({
      apiUrl: 'http://api', apiKey: 'K',
      cachePath, fetchFn: fakeFetch,
    });
    assert.equal(r.source, 'init_refreshed');
    assert.equal(r.refreshed, true);
    assert.deepEqual(r.data, newInitShape);
    // cache 應該被更新
    const newCache = readCache(cachePath);
    assert.equal(newCache.sync_token, 'NEW');
  });

  it('cache 24hr 過期 → 強制走 init (不打 sync-token)', async () => {
    const ago25h = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      sync_token: 'X', saved_at: ago25h, data: { iron_rule: [] }
    }));
    let syncTokenCalled = false;
    let initCalled = false;
    const fakeFetch = makeFetch([
      ['sync-token', () => { syncTokenCalled = true; return okJson({ sync_token: 'X' }); }],
      ['init', () => { initCalled = true; return okJson({ sync_token: 'X', data: { iron_rule: [] } }); }],
    ]);
    const r = await runConditionalSync({
      apiUrl: 'http://api', apiKey: 'K',
      cachePath, fetchFn: fakeFetch,
    });
    assert.equal(syncTokenCalled, false, '24hr 過期應跳過 sync-token、直接走 init');
    assert.equal(initCalled, true);
    assert.equal(r.source, 'init_refreshed');
  });

  it('sync-token endpoint 失敗 → fallback 走 init', async () => {
    writeCache({ sync_token: 'X', data: { iron_rule: [{ id: 1 }] } }, cachePath);
    const fakeFetch = makeFetch([
      ['sync-token', () => failJson(500)],
      ['init', () => okJson({ sync_token: 'NEW', data: { iron_rule: [{ id: 2 }] } })],
    ]);
    const r = await runConditionalSync({
      apiUrl: 'http://api', apiKey: 'K',
      cachePath, fetchFn: fakeFetch,
    });
    assert.equal(r.source, 'init_refreshed');
    assert.deepEqual(r.data, { iron_rule: [{ id: 2 }] });
  });

  it('init endpoint 也失敗 + 有 cache → fallback 用 cache', async () => {
    writeCache({ sync_token: 'X', data: { iron_rule: [{ id: 1 }] } }, cachePath);
    const fakeFetch = makeFetch([
      ['sync-token', () => failJson(500)],
      ['init', () => failJson(500)],
    ]);
    const r = await runConditionalSync({
      apiUrl: 'http://api', apiKey: 'K',
      cachePath, fetchFn: fakeFetch,
    });
    assert.equal(r.source, 'cache_fallback');
    assert.equal(r.refreshed, false);
    assert.deepEqual(r.data, { iron_rule: [{ id: 1 }] });
  });

  it('init 失敗 + 無 cache → source=error', async () => {
    const fakeFetch = makeFetch([
      ['sync-token', () => failJson(500)],
      ['init', () => failJson(500)],
    ]);
    const r = await runConditionalSync({
      apiUrl: 'http://api', apiKey: 'K',
      cachePath, fetchFn: fakeFetch,
    });
    assert.equal(r.source, 'error');
    assert.equal(r.data, null);
  });

  it('無 apiUrl/apiKey → 直接 fallback', async () => {
    writeCache({ sync_token: 'X', data: { iron_rule: [] } }, cachePath);
    const r = await runConditionalSync({
      apiUrl: '', apiKey: '',
      cachePath,
    });
    // 沒 token call、沒 init call、回 cache fallback
    assert.equal(r.source, 'cache_fallback');
  });
});
