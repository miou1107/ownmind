# v1.25.0 — Tasks

## Phase 1: Survey

- [x] Identify all user-facing Chinese strings in `src/routes/memory.js`
- [x] Confirm INSTRUCTIONS_SOP extent (lines 77-365, 288 lines)
- [x] List affected tests (auto-retry-sync-token, memory-upgrade-test, init-compact-compliance-instruction)

## Phase 2: Translation

- [x] UPDATE_PROMPT constant
- [x] checkSyncToken error messages
- [x] INSTRUCTIONS_SOP template literal (288 lines) — split into 5 chunks
- [x] enforcement alerts header
- [x] compliance report digest section
- [x] detectedTool fallback
- [x] HTTP error responses (~25 distinct strings)
- [x] Iron rule quality lint error + hint
- [x] is_test guard error
- [x] Brand banner `【】` → `[]` in SOP

## Phase 3: Test Updates

- [x] `tests/auto-retry-sync-token.test.js` — sync_token retry error message
- [x] `tests/memory-upgrade-test.test.js` — name_prefix + is_test assertions
- [x] `tests/init-compact-compliance-instruction.test.js` — widen digest section window from 800 → 1500 chars

## Phase 4: Verification

- [x] `node --check src/routes/memory.js` OK
- [x] `npm test` passes (1954 pass / 0 fail)
- [x] Manual: `rg "[\p{Han}]" src/routes/memory.js` shows only logger calls + comments + 2 hardcoded iron rule titles

## Phase 5: Release

- [x] Bump `package.json` to `1.25.0`
- [x] Add `CHANGELOG.md` entry
- [x] Update `FILELIST.md`
- [x] Sync trilingual READMEs
- [ ] Commit
- [ ] `git tag v1.25.0`
- [ ] Archive change folder
