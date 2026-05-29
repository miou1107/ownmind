# v1.26.0 — Tasks

## Phase 1: Survey

- [x] Count Chinese lines per file in `hooks/` (566 total across 20 files)
- [x] Classify: 537 pure-comment lines vs. 29 non-comment (mostly trailing inline comments)
- [x] Identify 4 user-facing string literals needing Track A patch
- [x] Confirm `ownmind-reply-lint.js:648` Chinese tokens are functional (preserve)

## Phase 2: Track B — Comment Translation (largest files first)

- [x] `hooks/ownmind-reply-lint.js` (188 Chinese lines; ~178 pure comment)
- [x] `hooks/ownmind-tty-echo.cjs` (44)
- [x] `hooks/ownmind-usage-scanner.js` (18)
- [x] `hooks/ownmind-git-pre-commit.js` (30)
- [x] `hooks/ownmind-git-post-commit.js` (5)
- [x] `hooks/ownmind-iron-rule-check.js` (15)
- [x] `hooks/ownmind-session-start.js` (6)
- [x] `hooks/ownmind-verify-trigger.js` (1) — also got Track A patch
- [x] `hooks/lib/flush-compliance-spool.js` (42)
- [x] `hooks/lib/conditional-sync-cli.js` (39)
- [x] `hooks/lib/conditional-sync.js` (38)
- [x] `hooks/lib/session-counter.js` (31)
- [x] `hooks/lib/rule-enforcer.js` (28)
- [x] `hooks/lib/lint-event-logger.js` (24)
- [x] `hooks/lib/build-compliance-events.js` (17)
- [x] `hooks/lib/bypass-handler.js` (15)
- [x] `hooks/lib/flush-pending-banners.js` (9)
- [x] `hooks/lib/sync-memory-files.js` (7) — also got Track A patch (×3 strings)
- [x] `hooks/lib/render-session-context.js` (7)
- [x] `hooks/lib/session-start-output.js` (2)

## Phase 3: Track A patch (user-facing string literals)

- [x] `hooks/lib/sync-memory-files.js:84` — MEMORY.md auto-sync header
- [x] `hooks/lib/sync-memory-files.js:85` — edit-via-MCP hint
- [x] `hooks/lib/sync-memory-files.js:145` — sync-failed warning
- [x] `hooks/ownmind-verify-trigger.js:66` — `'未命名規則'` fallback → `'(untitled rule)'`

## Phase 4: Verification

- [x] `rg '\p{Han}' hooks/` returns only `ownmind-reply-lint.js:658` (preserved)
- [x] `node --check` on every modified file
- [x] `npm test` passes (1954 pass / 0 fail — unchanged from baseline)
- [x] `rg '未命名規則'` across the whole repo — no other file depends on the exact phrase
- [x] `rg "由 OwnMind SessionStart hook"` against tests/ — no test breaks

## Phase 5: Release

- [x] Bump `package.json` to `1.26.0`
- [x] Add `CHANGELOG.md` v1.26.0 entry
- [x] Update `FILELIST.md` (new openspec entries + 20 hooks file changes documented)
- [x] Sync trilingual READMEs (per IR-131)
- [x] Commit (7da06e9)
- [x] `git tag v1.26.0`
- [ ] Archive change folder to `openspec/changes/archive/v1.26.0-i18n-hooks-internal/` (deferred — follows the established pattern of archiving in the next release's chore commit)
