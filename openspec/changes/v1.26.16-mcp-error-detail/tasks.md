# Tasks — v1.26.16 MCP client surfaces structured API error detail

## Phase 1: Root cause (done)

- [x] Reproduce path: server returns { error, errors[], hint }; MCP client only
      surfaced `error`. Confirmed in src/routes/memory.js + mcp/index.js callApi.

## Phase 2: TDD fix (done)

- [x] Write tests/api-error-message.test.js (6 cases). Verify RED (module missing).
- [x] Add mcp/lib/api-error-message.js `buildApiErrorMessage(data, text)`. Verify GREEN.
- [x] Wire callApi (mcp/index.js) to use it + import. Full suite green (2009/0/0).
- [x] Confirm sync_token retry untouched (error kept first; 17 retry tests green).

## Phase 3: Quality gates (done)

- [x] verification-before-completion — evidence: 2009 pass / 0 fail.
- [x] requesting-code-review — verdict safe to commit; no Critical/Important.
- [x] receiving-code-review — Minor ([object Object] if non-string errors item) is
      cosmetic, server emits strings, not changed. Pre-existing sync_token stale-409
      retry gap filed as a separate task.

## Phase 4: Release

- [ ] package.json 1.26.15 -> 1.26.16; CHANGELOG entry; FILELIST add new files; tag v1.26.16.
- [ ] Commit bug-fix files only (exclude the in-progress v1.26.17 i18n work). Push.
