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

/**
 * The one owner of this path. Exported because callers that inspect the file before handing it
 * to runConditionalSync (mcp/lib/local-locale-refresh.js's account guard) must look at exactly
 * the file this module would write; a second literal here and there would let the guard drift
 * off the real cache silently if the path ever moves.
 */
export const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.ownmind', 'cache', 'memories.json');
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;  // 24 hours
const SYNC_TOKEN_TIMEOUT_MS = 3000;
const INIT_TIMEOUT_MS = 8000;
/**
 * Issue #200, item 6 — how long a session start may wait on the server for memories.
 *
 * Claude Code gives the whole SessionStart hook 10 seconds. Unbounded, this sync could spend 3s
 * on the sync token and then 8s on the full init: 11s, past the limit, so on a slow network the
 * hook was cut off and the session started with no memories at all, even with a cache on disk.
 * The hooks pass this budget; past it, the cache on disk is served instead.
 */
export const SESSION_START_BUDGET_MS = 5000;
/** The least time worth giving a full init when there is no cache to fall back to. */
const MIN_INIT_WITHOUT_CACHE_MS = 1500;

/**
 * Read the local cache; returns { sync_token, saved_at, account, data } or null.
 *
 * v1.26.82 — `account` is new, and a cache belonging to a different one is refused.
 *
 * This file holds the whole init payload: profile, principles, iron rules. Before this
 * version it recorded nothing about whose it was, so changing credentials left the previous
 * account's memories on disk to be read, with nothing anywhere showing it. member-5 installed
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
  const info = await fetchSyncTokenInfo(apiUrl, apiKey, fetchFn);
  return info ? info.sync_token : null;
}

/**
 * v1.31.0 — the same request, keeping the fields the server sends beside the token. The
 * count of waiting lessons travels here because it is live state, not cached state: a
 * fresh cache must still say what the server says now. See overlayLiveFields.
 *
 * v1.33.0 — `handoffs` and `consolidation` ride the same way when the server sends them.
 * Neither is ever written to the cache (see LIVE_FIELDS), so a sync-token answer that
 * carries them is the only way a cache-fresh start learns about them; one that does not
 * leaves them absent, which the renderer treats as nothing to show.
 *
 * @returns {Promise<{ sync_token: string, lessons_waiting?: number, handoffs?: object[], consolidation?: object }|null>}
 */
export async function fetchSyncTokenInfo(apiUrl, apiKey, fetchFn = globalThis.fetch, timeoutMs = SYNC_TOKEN_TIMEOUT_MS) {
  if (!apiUrl || !apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${apiUrl.replace(/\/$/, '')}/api/memory/sync-token`;
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    const body = await res.json();
    if (!body || typeof body.sync_token !== 'string') return null;
    const info = { sync_token: body.sync_token };
    if (Number.isInteger(body.lessons_waiting)) info.lessons_waiting = body.lessons_waiting;
    if (Array.isArray(body.handoffs)) info.handoffs = body.handoffs;
    if (body.consolidation && typeof body.consolidation === 'object') info.consolidation = body.consolidation;
    return info;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fields that are true now rather than true when the cache was written. A fresh cache is
 * served with these replaced by what the sync-token answer just said; a cache served
 * without a server answer keeps whatever it had, which the renderer treats as unknown.
 */
export function overlayLiveFields(data, info) {
  if (!data || typeof data !== 'object' || !info) return data;
  const live = {};
  if (Number.isInteger(info.lessons_waiting)) live.lessons_waiting = info.lessons_waiting;
  if (Array.isArray(info.handoffs)) live.handoffs = info.handoffs;
  if (info.consolidation && typeof info.consolidation === 'object') live.consolidation = info.consolidation;
  if (Object.keys(live).length === 0) return data;
  return { ...data, ...live };
}

/**
 * v1.33.0 — fields that must never be served from disk. A handoff is accepted by the next
 * session in its project and a consolidation report is shown once; a cached copy would have
 * the AI accept the same handoff twice and relay the same report every start until the memory
 * table happened to move. The sync token does not cover these tables, so the cache cannot
 * know when they changed. They are stripped on write and overlaid live (overlayLiveFields,
 * hooks/lib/session-live-state.js) on read.
 */
export const LIVE_FIELDS = ['handoffs', 'consolidation'];

export function stripLiveFields(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out = { ...data };
  for (const key of LIVE_FIELDS) delete out[key];
  return out;
}

/**
 * Fetch the full init data.
 *
 * @returns {Promise<{ sync_token, data }|null>}
 */
export async function fetchInitFull(apiUrl, apiKey, fetchFn = globalThis.fetch, timeoutMs = INIT_TIMEOUT_MS) {
  if (!apiUrl || !apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    if (!fsModule.existsSync(dir)) fsModule.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const wrapped = {
      sync_token: payload.sync_token || '',
      saved_at: new Date().toISOString(),
      ...(account ? { account: accountFingerprint(account) } : {}),
      data: stripLiveFields(payload.data || payload),
    };
    // Owner-only: the file is every memory this account has. `mode` only applies when the
    // file is created, so a cache from an older version is tightened afterwards too.
    fsModule.writeFileSync(cachePath, JSON.stringify(wrapped, null, 2), { mode: 0o600 });
    if (process.platform !== 'win32' && typeof fsModule.chmodSync === 'function') {
      try { fsModule.chmodSync(cachePath, 0o600); } catch { /* the write succeeded */ }
    }
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
  // Optional total wait on the server, in ms (SESSION_START_BUDGET_MS from the hooks). Omitted,
  // the two requests keep their own timeouts, which is what a background caller wants.
  budgetMs,
  clock = Date.now,
}) {
  // v1.26.82 — the account is passed in, so a cache written under a different key is
  // refused rather than served. member-5 installed somebody else's key once; without this the
  // profile and iron rules downloaded then would still be on disk and still be read.
  //
  // No key at all → no account to compare against, and nothing new can be downloaded
  // either; the offline fallback keeps its old behaviour of serving whatever is there.
  const account = apiKey ? { apiUrl, apiKey } : undefined;
  const cache = readCache(cachePath, fsModule, account);
  const budgeted = Number.isFinite(budgetMs);
  const startedAt = clock();
  const remaining = () => budgetMs - (clock() - startedAt);

  // step 1: expired after 24hr → force refresh outright, don't waste a sync-token call.
  const cacheStale24hr = cache && cache.saved_at &&
    (now - Date.parse(cache.saved_at)) > STALE_THRESHOLD_MS;

  if (!cacheStale24hr && cache) {
    // step 2: compare against server sync_token.
    const tokenTimeout = budgeted ? Math.min(SYNC_TOKEN_TIMEOUT_MS, budgetMs) : SYNC_TOKEN_TIMEOUT_MS;
    const info = await fetchSyncTokenInfo(apiUrl, apiKey, fetchFn, tokenTimeout);
    if (info && cache.sync_token === info.sync_token) {
      return { source: 'cache_fresh', data: overlayLiveFields(cache.data, info), refreshed: false };
    }
    // When serverToken can't be obtained, shouldRefreshCache returns true → full init.
  }

  // step 3: full init download. Under a budget it gets what is left; with a cache to fall back
  // on and nothing left, the download is skipped, and with no cache it still gets a short try.
  let initTimeout = INIT_TIMEOUT_MS;
  if (budgeted) {
    initTimeout = Math.max(remaining(), cache ? 0 : MIN_INIT_WITHOUT_CACHE_MS);
  }
  const fullInit = initTimeout > 0 ? await fetchInitFull(apiUrl, apiKey, fetchFn, initTimeout) : null;
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
