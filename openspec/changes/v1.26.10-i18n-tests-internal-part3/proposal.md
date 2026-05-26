# v1.26.10 — i18n Phase 10 Part 3: tests/ remaining medium files (Track B)

## One-Line Summary

Translate JSDoc / `//` comments, `describe()` / `it()` titles, and assertion
hint messages across 15 medium `tests/*.test.js` files (each with 32–38
Chinese lines). Continuation of v1.26.6 (top 25) and v1.26.9 (next 14).
v1.26.11+ will cover the remaining ~80 small files.

## Scope Split

Phase 10 (the `tests/` translation) continues to be split across multiple
patches to keep each commit reviewable:

- **v1.26.6** — top 25 largest files (≥ 56 Chinese lines) — done.
- **v1.26.9** — next 14 files (39–55 Chinese lines) — done.
- **v1.26.10 (this patch)** — next 15 files (32–38 Chinese lines).
- **v1.26.11+ (next)** — remaining ~80 small files (< 32 Chinese lines).

## In Scope (15 files)

| # | File | Chinese lines |
|---|---|---|
| 1 | `tests/memory-error-classifier.test.js` | 38 |
| 2 | `tests/debug-route-beacon-version.test.js` | 38 |
| 3 | `tests/privacy-redact.test.js` | 37 |
| 4 | `tests/bug-report-spam-detector.test.js` | 37 |
| 5 | `tests/language-lint-v1195.test.js` | 36 |
| 6 | `tests/iron-rule-tier-digest.test.js` | 36 |
| 7 | `tests/conditional-sync.test.js` | 36 |
| 8 | `tests/mcp-log-event-uuid.test.js` | 35 |
| 9 | `tests/rule-enforcer-core.test.js` | 34 |
| 10 | `tests/mcp-tool-description-secret-warning.test.js` | 34 |
| 11 | `tests/verification-command-handlers.test.js` | 33 |
| 12 | `tests/migration-017-bug-reports-id-serial.test.js` | 33 |
| 13 | `tests/error-spool-mechanism.test.js` | 33 |
| 14 | `tests/bug-report-helpers.test.js` | 33 |
| 15 | `tests/install-prerequisite-auto-install.test.js` | 32 |

Estimated ~530 Chinese lines, mostly real comments / titles.

## Translation Categories

Same five-category rule as v1.26.6 / v1.26.9:

| Category | Action |
|---|---|
| JSDoc / `//` comments | **Translate** |
| `describe('xxx', ...)` titles | **Translate** |
| `it('xxx', ...)` titles | **Translate** |
| `assert.X(actual, expected, '...')` hint | **Translate** |
| String literals / fixtures | **Preserve** |
| Comparison literals (e.g. error-message regex targets) | **Preserve** |

## Out of Scope

- Test fixtures simulating user Chinese input (per CLAUDE.md §不在範圍).
- Iron-rule title literals that match production DB content.
- Reason strings emitted by `shared/secret-detect.js` and similar modules.
- The remaining ~80 smaller files — those go in v1.26.11+.

## Acceptance Criteria

- All 15 files in scope have JSDoc / comments / titles / assertion hints
  in English.
- Fixtures and string literals remain Chinese where they represent
  simulated user input or production-matching values.
- `npm test` passes: baseline 1999 must be preserved.
- `package.json` bumped to 1.26.10.
- CHANGELOG.md / FILELIST.md / READMEs (zh-TW / en / ja) updated.

## Risk

- **Low** — same risk profile as v1.26.6 / v1.26.9.
