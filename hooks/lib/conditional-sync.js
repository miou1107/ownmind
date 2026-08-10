#!/usr/bin/env node
/**
 * hooks/lib/conditional-sync.js — Conditional sync helper (v1.18.0)
 *
 * Why this exists (addresses the "should use a hash check, only sync when needed" request):
 *   Since v1.17.x the SessionStart hook always called /api/memory/init?compact=true in full,
 *   regardless of whether iron rules / memories had changed; 99% of sessions pulled the same
 *   30KB payload.
 *
 *   v1.18.0: completes the read-side conditional pull:
 *     1. Read sync_token + saved_at from local cache memories.json.
 *     2. Expired after 24hr → force a full init pull.
 *     3. Otherwise GET /api/memory/sync-token (~50 bytes) and compare.
 *     4. Equal → use local cache, skip the init download (saves 95% bandwidth).
 *     5. Different → full init + write new cache.
 *     6. Fallback paths: sync-token failure → full init; init failure → use cache.
 *
 * Design:
 *   - Pure functions + injected fetch / fs / now (testable).
 *   - Never throws — every failure has a fallback.
 *   - Uses the existing ~/.ownmind/cache/memories.json shape (sync_token + saved_at + data).
 *
 * Corresponds to spec.md §4.2.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { accountFingerprint } from '../../shared/scanners/base.js';

const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.ownmind', 'cache', 'memories.json');
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;  // 24 hours
const SYNC_TOKEN_TIMEOUT_MS = 3000;
const INIT_TIMEOUT_MS = 8000;

/**
 * Read the local cache; returns { sync_token, saved_at, account, data } or null.
 *
 * v1.26.82 — `account` is new, and a cache belonging to a different one is refused.
 *
 * This file holds the whole init payload: profile, principles, iron rules. Before this
 * version it recorded nothing about whose it was, so changing credentials left the previous
 * account's memories on disk to be read, with nothing anywhere showing it. Adam installed
 * somebody else's key once; that is what prompted the check.
 *
 * The scanner fixed the same hazard in v1.26.69 for its cursor file. This is the other half.
 *
 * A cache with no `account` at all is treated as someone else's, not as ours. Every machine
 * has one of those right now, and claiming it for whoever asks is precisely the bug. The
 * cost of being wrong the safe way is one extra download, once.
 *
 * @param {object} [account] — { apiUrl, apiKey }; omit to skip the check
 */
export function readCache(cachePath = DEFAULT_CACHE_PATH, fsModule = fs, account) {
  try {
    if (!fsModule.existsSync(cachePath)) return null;
    const cache = JSON.parse(fsModule.readFileSync(cachePath, 'utf8'));
    if (account) {
      if (cache?.account !== accountFingerprint(account)) return null;
    }
    if (!holdsInitPayload(cache)) return null;
    return cache;
  } catch {
    return null;
  }
}

/**
 * v1.26.138 — is this file's `data` an init payload, or somebody else's cache?
 *
 * `cache/memories.json` was shared with the MCP's offline cache, which stores the same
 * memories under a different schema: one array per type, keyed `iron_rule`, `coding_standard`,
 * `team_standard`. An init response uses the plural forms and puts `profile` in a single
 * object, so the singular keys are a reliable signature of the other writer.
 *
 * Measured on Windows 2026-08-10: after an MCP init, step 2 of runConditionalSync saw a
 * matching sync_token, returned the type-keyed object as the init payload, and
 * renderSessionContext produced a banner with no version, no iron rules and no profile —
 * while the hook logged `init: ok`. Nothing failed; the memory load just silently contained
 * nothing.
 *
 * The MCP writes its own file as of this version, so the two no longer collide. This check is
 * the part that does not depend on that: a cache whose shape this renderer cannot read is
 * refused, the hook downloads a fresh one, and the machine heals itself on the next session
 * rather than needing the wrong file deleted by hand.
 *
 * Deliberately a negative test. A positive one would have to name a field every account is
 * guaranteed to have, and an account with no rules and no profile has almost none.
 *
 * @param {object|null} cache
 * @returns {boolean} false when the payload belongs to a different consumer
 */
export function holdsInitPayload(cache) {
  const data = cache?.data;
  if (!data || typeof data !== 'object') return false;
  for (const typeKeyed of ['iron_rule', 'coding_standard', 'team_standard', 'standard_detail']) {
    if (Array.isArray(data[typeKeyed])) return false;
  }
  return true;
}

/**
 * Decide whether to re-fetch — 4 rules:
 *   1. cache missing → yes
 *   2. cache.saved_at older than 24hr → yes (safety net against sync_token miscalculation pinning cache forever)
 *   3. cache.sync_token !== server sync_token → yes
 *   4. otherwise → no
 */
export function shouldRefreshCache(cache, serverSyncToken, now = Date.now()) {
  if (!cache || !cache.sync_token || !cache.saved_at) return true;

  const savedMs = Date.parse(cache.saved_at);
  if (Number.isNaN(savedMs)) return true;
  if (now - savedMs > STALE_THRESHOLD_MS) return true;

  if (!serverSyncToken) return true;  // can't reach server token → refresh conservatively

  return cache.sync_token !== serverSyncToken;
}

/**
 * Fetch the server sync_token (lightweight ~50 bytes, 3s timeout).
 *
 * @param {string} apiUrl - https://example.com/ownmind
 * @param {string} apiKey
 * @param {Function} [fetchFn=globalThis.fetch] — injected for tests
 * @returns {Promise<string|null>} 12-char hex, or null on failure.
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
 * Fetch the full init data.
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
 * Write the cache.
 *
 * v1.26.82 — stamps which account it belongs to. The fingerprint is a hash of server + key,
 * so the file identifies an account without becoming somewhere to read a key from.
 *
 * @param {object} [account] — { apiUrl, apiKey }; omit and the cache stays unattributed,
 *                             which `readCache` will then refuse on the next run
 */
export function writeCache(payload, cachePath = DEFAULT_CACHE_PATH, fsModule = fs, account) {
  try {
    const dir = path.dirname(cachePath);
    if (!fsModule.existsSync(dir)) fsModule.mkdirSync(dir, { recursive: true });
    const wrapped = {
      sync_token: payload.sync_token || '',
      saved_at: new Date().toISOString(),
      ...(account ? { account: accountFingerprint(account) } : {}),
      data: payload.data || payload,
    };
    fsModule.writeFileSync(cachePath, JSON.stringify(wrapped, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Main entry: full conditional sync flow.
 *
 * Returns { source, data, refreshed }
 *   - source: 'cache_fresh' | 'init_refreshed' | 'cache_fallback' | 'error'
 *   - data: iron rules / memories payload (init API shape)
 *   - refreshed: bool — whether new data was actually downloaded (decides whether to rewrite
 *     local skill files).
 */
export async function runConditionalSync({
  apiUrl,
  apiKey,
  cachePath = DEFAULT_CACHE_PATH,
  fetchFn = globalThis.fetch,
  fsModule = fs,
  now = Date.now(),
}) {
  // v1.26.82 — the account is passed in, so a cache written under a different key is
  // refused rather than served. Adam installed somebody else's key once; without this the
  // profile and iron rules downloaded then would still be on disk and still be read.
  //
  // No key at all → no account to compare against, and nothing new can be downloaded
  // either; the offline fallback keeps its old behaviour of serving whatever is there.
  const account = apiKey ? { apiUrl, apiKey } : undefined;
  const cache = readCache(cachePath, fsModule, account);

  // step 1: expired after 24hr → force refresh outright, don't waste a sync-token call.
  const cacheStale24hr = cache && cache.saved_at &&
    (now - Date.parse(cache.saved_at)) > STALE_THRESHOLD_MS;

  if (!cacheStale24hr && cache) {
    // step 2: compare against server sync_token.
    const serverToken = await fetchSyncTokenLight(apiUrl, apiKey, fetchFn);
    if (serverToken && cache.sync_token === serverToken) {
      return { source: 'cache_fresh', data: cache.data, refreshed: false };
    }
    // When serverToken can't be obtained, shouldRefreshCache returns true → full init.
  }

  // step 3: full init download.
  const fullInit = await fetchInitFull(apiUrl, apiKey, fetchFn);
  if (fullInit) {
    writeCache(fullInit, cachePath, fsModule, account);
    return { source: 'init_refreshed', data: fullInit.data || fullInit, refreshed: true };
  }

  // step 4: init failed → fallback to local cache (even stale, better than nothing).
  if (cache) {
    return { source: 'cache_fallback', data: cache.data, refreshed: false };
  }

  // Completely unrecoverable.
  return { source: 'error', data: null, refreshed: false };
}
