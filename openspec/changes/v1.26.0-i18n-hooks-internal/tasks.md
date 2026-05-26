# v1.26.0 — Tasks

## Phase 1: Survey

- [x] Count Chinese lines per file in `hooks/` (566 total across 20 files)
- [x] Classify: 537 pure-comment lines vs. 29 non-comment (mostly trailing inline comments)
- [x] Identify 4 user-facing string literals needing Track A patch
- [x] Confirm `ownmind-reply-lint.js:648` Chinese tokens are functional (preserve)

## Phase 2: Track B — Comment Translation (largest files first)

- [ ] `hooks/ownmind-reply-lint.js` (188 Chinese lines; ~178 pure comment)
- [ ] `hooks/ownmind-tty-echo.cjs` (44)
- [ ] `hooks/ownmind-usage-scanner.js` (18)
- [ ] `hooks/ownmind-git-pre-commit.js` (30)
- [ ] `hooks/ownmind-git-post-commit.js` (5)
- [ ] `hooks/ownmind-iron-rule-check.js` (15)
- [ ] `hooks/ownmind-session-start.js` (6)
- [ ] `hooks/ownmind-verify-trigger.js` (1) — also gets Track A patch
- [ ] `hooks/lib/flush-compliance-spool.js` (42)
- [ ] `hooks/lib/conditional-sync-cli.js` (39)
- [ ] `hooks/lib/conditional-sync.js` (38)
- [ ] `hooks/lib/session-counter.js` (31)
- [ ] `hooks/lib/rule-enforcer.js` (28)
- [ ] `hooks/lib/lint-event-logger.js` (24)
- [ ] `hooks/lib/build-compliance-events.js` (17)
- [ ] `hooks/lib/bypass-handler.js` (15)
- [ ] `hooks/lib/flush-pending-banners.js` (9)
- [ ] `hooks/lib/sync-memory-files.js` (7) — also gets Track A patch (×3 strings)
- [ ] `hooks/lib/render-session-context.js` (7)
- [ ] `hooks/lib/session-start-output.js` (2)

## Phase 3: Track A patch (user-facing string literals)

- [ ] `hooks/lib/sync-memory-files.js:84` — MEMORY.md auto-sync header
- [ ] `hooks/lib/sync-memory-files.js:85` — edit-via-MCP hint
- [ ] `hooks/lib/sync-memory-files.js:145` — sync-failed warning
- [ ] `hooks/ownmind-verify-trigger.js:66` — `'未命名規則'` fallback → `'(untitled rule)'`

## Phase 4: Verification

- [ ] `rg '\p{Han}' hooks/` returns only `ownmind-reply-lint.js:648` (preserved)
- [ ] `node --check` on every modified file
- [ ] `npm test` passes (green count unchanged from pre-change baseline)
- [ ] `rg '未命名規則'` across the whole repo — confirm no other file depends on the exact phrase
- [ ] `rg "由 OwnMind SessionStart hook"` against tests/ — confirm no test breaks

## Phase 5: Release

- [ ] Bump `package.json` to `1.26.0`
- [ ] Add `CHANGELOG.md` v1.26.0 entry
- [ ] Review `FILELIST.md` (should be unchanged — no new files)
- [ ] Sync trilingual READMEs (per IR-131)
- [ ] Commit
- [ ] `git tag v1.26.0`
- [ ] Archive change folder to `openspec/changes/archive/v1.26.0-i18n-hooks-internal/` (after release)
