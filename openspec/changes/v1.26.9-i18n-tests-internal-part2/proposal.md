# v1.26.9 — i18n Phase 10 Part 2: tests/ medium files (≥ 39 Chinese lines) to English (Track B)

## One-Line Summary

Translate JSDoc / `//` comments, `describe()` / `it()` titles, and assertion
hint messages across the next ~14 `tests/*.test.js` files (each with 39–56
Chinese lines). Continuation of v1.26.0–v1.26.6 Track B (developer-facing
internal English). The remaining smaller files (< 39 Chinese lines) are
deferred to v1.26.10.

## Scope Split

Phase 10 (the `tests/` translation) is split across three patches to keep
each commit reviewable and avoid running out of context mid-batch:

- **v1.26.6** — top 25 largest files (≥ 56 Chinese lines) — done.
- **v1.26.9 (this patch)** — next 14 files (39–55 Chinese lines).
- **v1.26.10 (next)** — remaining ~97 small files (< 39 Chinese lines).

The push to origin already happened after v1.26.6 / v1.26.7 / v1.26.8;
no additional push gating is needed for the tests/ track.

## In Scope (14 files)

| # | File | Chinese lines |
|---|---|---|
| 1 | `tests/activity-batch-dedup.test.js` | 56 |
| 2 | `tests/templates.test.js` | 54 |
| 3 | `tests/reply-lint.test.js` | 52 |
| 4 | `tests/admin-reset-password.test.js` | 52 |
| 5 | `tests/sweep-old-backups.test.js` | 49 |
| 6 | `tests/pre-commit-secret.test.js` | 49 |
| 7 | `tests/session-start-render.test.js` | 47 |
| 8 | `tests/me-profile-put.test.js` | 47 |
| 9 | `tests/jargon-context-memory.test.js` | 46 |
| 10 | `tests/iron-rule-suggest.test.js` | 44 |
| 11 | `tests/reply-lint-pending-spool.test.js` | 43 |
| 12 | `tests/auth-401-observability.test.js` | 43 |
| 13 | `tests/reply-lint-hook-v1911.test.js` | 41 |
| 14 | `tests/migration-016-bug-reports.test.js` | 39 |

Estimated ~675 Chinese lines, mostly real comments / titles (fixture density
is lower in these medium-sized files than in the top 25).

## Translation Categories

Same five-category rule as v1.26.6:

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
- Reason strings emitted by `shared/secret-detect.js` and similar
  modules (left as Track A work).
- The remaining ~97 smaller files — those go in v1.26.10.

## Acceptance Criteria

- All 14 files in scope have JSDoc / comments / titles / assertion hints
  in English.
- Fixtures and string literals remain Chinese where they represent
  simulated user input or production-matching values.
- `npm test` passes: baseline 1999 must be preserved (no assertion changes
  expected because we are not touching fixture strings).
- `package.json` bumped to 1.26.9.
- CHANGELOG.md / FILELIST.md / READMEs (zh-TW / en / ja) updated.

## Risk

- **Low** — same risk profile as v1.26.6. Only touch lines clearly
  identified as comment / title / hint; preserve everything else.
