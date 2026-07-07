# v1.26.17 — sync_token stale-409 auto-retry (code-based detection)

## One-Line Summary

Fix the sync_token 409 auto-retry so it fires for the stale-token case — the
very scenario it was built for — by detecting via a structured response `code`
instead of matching the error message text.

## Root Cause

- `mcp/lib/sync-token-retry.js` `shouldRetryForSyncToken` decided whether to
  auto-retry a 409 by `/sync_token/i.test(errorMessage)`.
- Server `src/routes/memory.js` `checkSyncToken` returns two 409s:
  - no token: message contains "sync_token" → retry fired.
  - **stale token**: message is "State has changed — please call ownmind_init
    again to refresh memory" → **no "sync_token" substring → retry never fired**.
- Yet the module's own doc says the retry exists primarily for the stale case
  (multiple concurrent AI sessions bumping each other's token). The primary
  scenario was silently unhandled.

## Fix

- Server `checkSyncToken`: both 409 errorResponses now carry an explicit `code`
  — `sync_token_required` (no token) and `sync_token_stale` (stale). Existing
  fields (error / require_init / stale / new_token) are kept for compatibility.
- `shouldRetryForSyncToken`: takes a `body` param and returns true when
  `body.code` is `sync_token_stale` or `sync_token_required` (robust,
  text-independent). Falls back to the old `/sync_token/i` message match for
  older servers that don't send a code.
- `mcp/index.js` callApi passes `body: data` to the helper.

## Out of Scope

- Could also use `new_token` (already in the stale body) to retry without a
  second GET round-trip — left as a future optimization, not needed for the fix.

## Verification

- `tests/auto-retry-sync-token.test.js` +3 cases: stale code → retry (the
  reproduction; message deliberately lacks "sync_token"), required code → retry,
  unrelated code (`duplicate_entry`) → NO retry (over-trigger guard).
- TDD: reproduction verified RED first, then GREEN.
- Over-trigger checked: the only other 409 (PG unique_violation 23505 in
  memory-error-classifier) has no sync_token code and no matching message, so it
  correctly does not retry.
- Full suite 2012 pass / 0 fail / 0 skipped.
