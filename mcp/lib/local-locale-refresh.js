import { runConditionalSync } from '../../hooks/lib/conditional-sync.js';

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
