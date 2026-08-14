import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runConditionalSync, DEFAULT_CACHE_PATH } from '../../hooks/lib/conditional-sync.js';
import { accountFingerprint } from '../../shared/scanners/base.js';

/**
 * Fix round 2 — is the cache on disk somebody else's?
 *
 * The MCP resolves its credentials from `process.env` alone (mcp/index.js). The hooks resolve
 * theirs files-first, env-last (scripts/install-helpers/resolve-credentials.cjs:
 * `~/.claude/settings.json` -> `settings.local.json` -> `.claude.json` -> env). On a machine
 * running more than one OwnMind account those two resolve to different accounts — and this
 * product's own author is such a user — while `cache/memories.json` has exactly one owner,
 * the hooks.
 *
 * `readCache` (v1.26.82) already refuses to *serve* a cache stamped with another account, but
 * that guard is read-side only: `runConditionalSync` then downloads this account's init and
 * writes it straight over the top. Measured: the other account's profile, iron rules and
 * digests are destroyed, `getLocale` (which has no fingerprint check of its own) starts
 * serving this account's language on a machine whose hooks are the other one, and at that
 * account's next SessionStart `readCache` correctly refuses the now-foreign file — so an
 * offline session there loads no memories at all, strictly worse than the `cache_fallback` it
 * would otherwise have had.
 *
 * Only a *differing* stamp counts. A cache with no `account` field (pre-v1.26.82, or a first
 * install) is refused by `readCache` for every account alike, so it is dead weight to whoever
 * holds it: overwriting it destroys nothing anyone could have read, and is exactly what a
 * normal SessionStart already does. Treating those as foreign would instead leave every
 * upgrading machine permanently unable to refresh here.
 *
 * @param {string} cachePath
 * @param {{apiUrl?: string, apiKey?: string}} creds
 * @returns {boolean} true only when a cache exists and is stamped with a different account
 */
function cacheBelongsToAnotherAccount(cachePath, creds) {
  let stamped;
  try {
    stamped = JSON.parse(fs.readFileSync(cachePath, 'utf8'))?.account;
  } catch {
    // Absent, unreadable or corrupt — nothing of anyone's to protect, and this must never
    // throw into the set-locale tool call.
    return false;
  }
  if (typeof stamped !== 'string' || !stamped) return false;
  return stamped !== accountFingerprint(creds);
}

/**
 * Task 5 fix round 1 (gate-message-i18n) — immediate local propagation.
 *
 * The sync-token fix (src/utils/syncToken.js) makes the account's locale preference part of
 * the token, so the existing SessionStart conditional-sync machinery re-inits and picks up a
 * new value on its own — but only at that machine's *next* session start. On a user decision,
 * the machine that actually calls `ownmind_set_locale` must not have to wait: its very next
 * hook invocation should already resolve the new language.
 *
 * This reuses `runConditionalSync` verbatim rather than hand-rolling a second cache writer or
 * patching `cache/memories.json` in place. That file has exactly one owner
 * (`hooks/lib/conditional-sync.js` — see the schema-collision history in `mcp/offline.js`,
 * which is why the MCP's *own* offline cache lives at a different path and must never be used
 * here). Calling the owner's own top-level sync function is the smallest change that cannot
 * drift out of sync with it: whatever `hooks/lib/locale.js` reads after a normal SessionStart
 * sync is exactly what this function leaves behind, because it is the same code path.
 *
 * Because the server write already changed the account's sync_token (by construction — the
 * caller is expected to invoke this only after a successful `PUT /locale`), the sync-token
 * comparison inside `runConditionalSync` finds a mismatch and downloads a fresh `GET /init`,
 * the same as any other write would. Nothing here is locale-specific except *when* it is
 * called.
 *
 * What `ok` claims: **the local cache now reflects the server's current state**, so the next
 * hook invocation on this machine resolves the new language. Two of `runConditionalSync`'s
 * four outcomes satisfy that, and the success condition accepts both:
 *
 *   `init_refreshed`  the expected path — the token moved, a fresh payload was downloaded
 *   `cache_fresh`     the token already matched, so the cache on disk is current and there
 *                     was nothing to fetch. Reachable two ways: another process (a session
 *                     start, a concurrent tool call) synced in the window between the PUT and
 *                     this call, or the PUT re-selected the locale the account already had, a
 *                     no-op write that moves no token. In both the postcondition holds.
 *
 *   `cache_fallback`  init failed, whatever is on disk was served — it may predate the write
 *   `error`           nothing usable at all
 *
 * A fifth outcome is produced here rather than by `runConditionalSync`:
 *
 *   `account_mismatch` the cache on disk belongs to a different account, so it was left
 *                      untouched and nothing was synced — see cacheBelongsToAnotherAccount()
 *
 * Those last two are the ones that mean "this machine may still answer in the old language",
 * and only those report `ok: false`. Narrowing success to `init_refreshed` alone would have
 * reported failure for a cache that is demonstrably correct, which is a worse lie than the
 * one it would prevent: the caller uses this to decide whether to tell the user the change
 * has taken effect here, and under `cache_fresh` it has.
 *
 * @param {object} opts
 * @param {string} opts.apiUrl
 * @param {string} opts.apiKey
 * @param {string} [opts.cachePath] — override for tests; production uses
 *   `runConditionalSync`'s own default (`~/.ownmind/cache/memories.json`, the same file
 *   `hooks/lib/locale.js` reads).
 * @param {Function} [opts.fetchFn] — override for tests; defaults to `runConditionalSync`'s
 *   own default (`globalThis.fetch`).
 * @returns {Promise<{ok: boolean, source: string}>} never throws — a failure here must not
 *   fail the `ownmind_set_locale` tool call. The server write already succeeded and every
 *   machine (including this one, as a fallback) still picks up the change through the normal
 *   sync-token path at its next session start.
 */
export async function refreshLocalCacheForLocale({ apiUrl, apiKey, cachePath, fetchFn } = {}) {
  try {
    if (cacheBelongsToAnotherAccount(cachePath || DEFAULT_CACHE_PATH, { apiUrl, apiKey })) {
      return { ok: false, source: 'account_mismatch' };
    }

    const result = await runConditionalSync({ apiUrl, apiKey, cachePath, fetchFn });
    const ok = result.source === 'init_refreshed' || result.source === 'cache_fresh';
    return { ok, source: result.source };
  } catch {
    // runConditionalSync is itself documented as "never throws — every failure has a
    // fallback"; this catch exists so a future change to that guarantee cannot turn into an
    // unhandled rejection here, degrading a set-locale response instead of failing it.
    return { ok: false, source: 'error' };
  }
}
