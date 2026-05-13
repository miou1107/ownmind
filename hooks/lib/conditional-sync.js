#!/usr/bin/env node
/**
 * hooks/lib/conditional-sync.js — Conditional sync helper (v1.18.0)
 *
 * 為什麼存在（解 Vin 提的「應該用 hash 檢查、有需要再同步」）：
 *   v1.17.x 起 SessionStart hook 每次都全量打 /api/memory/init?compact=true、
 *   不管鐵律 / 記憶有沒有變、99% sessions 都拉了同一份 30KB 資料下來。
 *
 *   v1.18.0：補完讀取端 conditional pull
 *     1. 讀 local cache memories.json 的 sync_token + saved_at
 *     2. 24hr 過期 → 強制走全量 init
 *     3. 否則 GET /api/memory/sync-token (~50 bytes) 比對
 *     4. 相同 → 用 local cache、跳過 init download (省 95% 流量)
 *     5. 不同 → 全量 init + 寫新 cache
 *     6. fallback 路徑：sync-token 失敗 → 全量 init / init 失敗 → 用 cache
 *
 * 設計：
 *   - 純函式 + 注入 fetch / fs / now (好測試)
 *   - 永不 throw、失敗都有 fallback
 *   - 用既有 ~/.ownmind/cache/memories.json 格式 (sync_token + saved_at + data)
 *
 * 對應 spec.md §4.2
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.ownmind', 'cache', 'memories.json');
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;  // 24 小時
const SYNC_TOKEN_TIMEOUT_MS = 3000;
const INIT_TIMEOUT_MS = 8000;

/**
 * 讀本地 cache、回 { sync_token, saved_at, data } 或 null
 */
export function readCache(cachePath = DEFAULT_CACHE_PATH, fsModule = fs) {
  try {
    if (!fsModule.existsSync(cachePath)) return null;
    return JSON.parse(fsModule.readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 判斷是否該重新拉 — 4 條規則：
 *   1. cache 不存在 → 是
 *   2. cache.saved_at 超過 24hr → 是（保險、防 sync_token 算錯永久 cache）
 *   3. cache.sync_token !== server sync_token → 是
 *   4. 否則 → 否
 */
export function shouldRefreshCache(cache, serverSyncToken, now = Date.now()) {
  if (!cache || !cache.sync_token || !cache.saved_at) return true;

  const savedMs = Date.parse(cache.saved_at);
  if (Number.isNaN(savedMs)) return true;
  if (now - savedMs > STALE_THRESHOLD_MS) return true;

  if (!serverSyncToken) return true;  // 拿不到 server token → 保守 refresh

  return cache.sync_token !== serverSyncToken;
}

/**
 * 抓 server 端 sync_token (lightweight ~50 bytes、3 秒 timeout)
 *
 * @param {string} apiUrl - https://kkvin.com/ownmind
 * @param {string} apiKey
 * @param {Function} [fetchFn=globalThis.fetch] — 注入式給測試
 * @returns {Promise<string|null>} 12-char hex 或 null（失敗）
 */
export async function fetchSyncTokenLight(apiUrl, apiKey, fetchFn = globalThis.fetch) {
  if (!apiUrl || !apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TOKEN_TIMEOUT_MS);
  try {
    const url = `${apiUrl.replace(/\/$/, '')}/api/memory/sync-token`;
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    const body = await res.json();
    return body && typeof body.sync_token === 'string' ? body.sync_token : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓全量 init data
 *
 * @returns {Promise<{ sync_token, data }|null>}
 */
export async function fetchInitFull(apiUrl, apiKey, fetchFn = globalThis.fetch) {
  if (!apiUrl || !apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INIT_TIMEOUT_MS);
  try {
    const url = `${apiUrl.replace(/\/$/, '')}/api/memory/init?compact=true`;
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 寫 cache
 */
export function writeCache(payload, cachePath = DEFAULT_CACHE_PATH, fsModule = fs) {
  try {
    const dir = path.dirname(cachePath);
    if (!fsModule.existsSync(dir)) fsModule.mkdirSync(dir, { recursive: true });
    const wrapped = {
      sync_token: payload.sync_token || '',
      saved_at: new Date().toISOString(),
      data: payload.data || payload,
    };
    fsModule.writeFileSync(cachePath, JSON.stringify(wrapped, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Main entry: conditional sync 完整流程
 *
 * 回傳 { source, data, refreshed }
 *   - source: 'cache_fresh' | 'init_refreshed' | 'cache_fallback' | 'error'
 *   - data: 鐵律 / 記憶資料（用 init API shape）
 *   - refreshed: bool — 是否真的下載了新資料（用來決定要不要重寫本地 skill files）
 */
export async function runConditionalSync({
  apiUrl,
  apiKey,
  cachePath = DEFAULT_CACHE_PATH,
  fetchFn = globalThis.fetch,
  fsModule = fs,
  now = Date.now(),
}) {
  const cache = readCache(cachePath, fsModule);

  // step 1: 24hr 過期 → 直接強制 refresh、不浪費一個 sync-token call
  const cacheStale24hr = cache && cache.saved_at &&
    (now - Date.parse(cache.saved_at)) > STALE_THRESHOLD_MS;

  if (!cacheStale24hr && cache) {
    // step 2: 拿 server sync_token 比對
    const serverToken = await fetchSyncTokenLight(apiUrl, apiKey, fetchFn);
    if (serverToken && cache.sync_token === serverToken) {
      return { source: 'cache_fresh', data: cache.data, refreshed: false };
    }
    // serverToken 拿不到時、shouldRefreshCache 會回 true、走全量 init
  }

  // step 3: 全量 init download
  const fullInit = await fetchInitFull(apiUrl, apiKey, fetchFn);
  if (fullInit) {
    writeCache(fullInit, cachePath, fsModule);
    return { source: 'init_refreshed', data: fullInit.data || fullInit, refreshed: true };
  }

  // step 4: init 失敗 → fallback 用 local cache（即使過期、也比沒資料好）
  if (cache) {
    return { source: 'cache_fallback', data: cache.data, refreshed: false };
  }

  // 完全沒救
  return { source: 'error', data: null, refreshed: false };
}
