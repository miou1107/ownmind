# v1.26.1 — Tasks

## Phase 1: Registry

- [x] Add `clt_user_reported_other` to `shared/bug-fingerprints.js` `BUG_FINGERPRINT_REGISTRY`

## Phase 2: Server + MCP

- [x] `src/routes/bug-reports.js:80` — update error message to mention `clt_user_reported_other`
- [x] `mcp/index.js` `ownmind_report_bug` `bug_fingerprint` field description — relax "must NOT be fabricated", point to the escape-hatch fingerprint

## Phase 3: Hook stderr disambiguation

- [x] `hooks/ownmind-reply-lint.js` block path — append disambiguation line
- [x] `hooks/ownmind-reply-lint.js` downgrade path — append disambiguation line
- [x] `hooks/ownmind-git-pre-commit.js` formatBlockMessage — append disambiguation line

## Phase 4: Tests

- [x] `tests/bug-fingerprints.test.js` — assert `clt_user_reported_other` registered with category `clt`
- [x] `tests/bug-report-helpers.test.js` — `withReportSuggestion` works with the new fingerprint
- [x] No existing test depended on the old Chinese 400 error message string (verified by grep)
- [x] `npm test` passes (1956 pass / 0 fail — 2 new tests added)

## Phase 5: Release

- [x] Bump `package.json` to `1.26.1`
- [x] Add `CHANGELOG.md` v1.26.1 entry
- [x] Update `FILELIST.md`
- [x] Sync trilingual READMEs (per IR-131)
- [ ] Commit
- [ ] `git tag v1.26.1`
- [ ] Archive change folder (deferred, follows release pattern)
