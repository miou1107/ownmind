# Tasks — v1.26.17 sync_token stale-409 auto-retry

## Phase 1: Root cause (done)

- [x] Confirmed: shouldRetryForSyncToken matched message text; server stale-409
      message lacks "sync_token", so the stale case never retried. checkSyncToken
      (memory.js:48) is the single source, 5 call sites.

## Phase 2: TDD fix (done)

- [x] Add 3 cases to tests/auto-retry-sync-token.test.js (stale code, required
      code, unrelated code → no retry). Verify RED (2 fail).
- [x] sync-token-retry.js: add `body` param, code-first detection + message fallback. GREEN.
- [x] memory.js checkSyncToken: add code sync_token_required / sync_token_stale.
- [x] mcp/index.js callApi: pass body:data. Update stale module doc comment.
- [x] Full suite 2012 / 0 / 0.

## Phase 3: Quality gates (done)

- [x] verification-before-completion — evidence 2012 pass.
- [x] requesting-code-review — verdict safe to commit; only Minor (stale doc) — fixed.
- [x] receiving-code-review — over-trigger guard confirmed (unique_violation 23505 not retried).

## Phase 4: Release

- [ ] package.json 1.26.16 -> 1.26.17; CHANGELOG; FILELIST add this proposal; tag v1.26.17.
- [ ] Commit fix files only (exclude the in-progress v1.26.18 i18n work). Push.
