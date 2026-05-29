# v1.26.6 — i18n Phase 10 Part 1: tests/ Largest 25 Files to English (Track B)

## One-Line Summary

Translate JSDoc / `//` comments, `describe()` / `it()` titles, and assertion
hint messages across the 25 largest `tests/*.test.js` files (each with ≥ 56
Chinese lines). Continuation of v1.26.0-v1.26.5 Track B (developer-facing
internal English). v1.26.7 will cover the remaining 111 smaller files.

## Scope Split (per user decision 2026-05-26)

The full `tests/` translation is split into two patches to keep each commit
reviewable and avoid context blow-up:

- **v1.26.6 (this patch)** — top 25 files by Chinese line count, ~60% of total
  Chinese density. Covers files where comment / fixture mix is densest and
  most likely to need careful per-line decisions.
- **v1.26.7 (next patch)** — remaining 111 smaller files.

Push `v1.26.0` ~ `v1.26.7` to origin together once both patches land.

## In Scope (25 files)

| # | File | Chinese lines |
|---|---|---|
| 1 | `tests/iron-rule-quality.test.js` | 150 |
| 2 | `tests/verification.test.js` | 141 |
| 3 | `tests/secret-detect-unit.test.js` | 132 |
| 4 | `tests/ownmind-tty-echo.test.js` | 120 |
| 5 | `tests/reply-lint-hook.test.js` | 98 |
| 6 | `tests/disable-details-snapshot.test.js` | 95 |
| 7 | `tests/memory-secret-guard.test.js` | 93 |
| 8 | `tests/self-check.test.js` | 91 |
| 9 | `tests/ps1-windows-compat.test.js` | 87 |
| 10 | `tests/iron-rule-quality-skill-md.test.js` | 81 |
| 11 | `tests/privacy-detect-unit.test.js` | 79 |
| 12 | `tests/mcp-auto-update-cross-platform.test.js` | 78 |
| 13 | `tests/me-pitfalls.test.js` | 74 |
| 14 | `tests/secret-mgmt.test.js` | 68 |
| 15 | `tests/iron-rule-origin-context.test.js` | 68 |
| 16 | `tests/p3-update-event-semantics.test.js` | 67 |
| 17 | `tests/reply-lint-hook-v1193-block.test.js` | 66 |
| 18 | `tests/setup-wizard.test.js` | 58 |
| 19 | `tests/enrich-error.test.js` | 58 |
| 20 | `tests/reply-lint-hook-v197.test.js` | 57 |
| 21 | `tests/upgrade-complete-beacon.test.js` | 56 |
| 22 | `tests/me-report.test.js` | 56 |
| 23 | `tests/language-lint-v1193.test.js` | 56 |
| 24 | `tests/iron-rule-sync.test.js` | 56 |
| 25 | `tests/flush-compliance-spool.test.js` | 56 |

Estimated ~2025 Chinese lines, of which roughly half are real comments /
titles and half are fixtures (per project CLAUDE.md exclusion list).

## Translation Categories

Per `tests/` file, every Chinese line falls into one of five categories:

| Category | Example | Action |
|---|---|---|
| JSDoc / `//` comments | `// CHECK_HANDLERS unit test` | **Translate** |
| `describe('xxx', ...)` titles | `describe('lintIronRule passes valid rules', ...)` | **Translate** |
| `it('xxx', ...)` titles | `it('valid rule returns ok=true', ...)` | **Translate** |
| `assert.X(actual, expected, '...')` hint | `assert.equal(r.ok, true, 'should not fail')` | **Translate** |
| String literals / fixtures | `'I use ownmind to manage rules'` (test input) | **Preserve** |

## Out of Scope (Preserved on Purpose)

Per `CLAUDE.md` §不在範圍 + project precedent:

- **Test fixtures simulating user Chinese input** — any string passed as test
  data, regex pattern target, or assertion comparison target stays Chinese.
- **Iron rule title literals** that match production DB content (e.g.
  `'學到東西必須全層同步更新'`) — must match what server actually stores.
- **Keyword detection comparison targets** (e.g.
  `'keyword:應用程式密碼'`) — fixture: these are the literal rule names
  the secret-detector emits.
- **i18n locale JSON values** (`zh-TW.json` etc.) — translation tables
  themselves stay Chinese on the Chinese side.

## Acceptance Criteria

- All 25 files in scope have JSDoc / comments / titles / assertion hints
  in English.
- Fixtures and string literals remain Chinese where they represent
  simulated user input or production-matching values.
- `npm test` passes: baseline 1956 / 0 must be preserved (no assertion
  changes expected because we are not touching string-comparison fixtures).
- `package.json` bumped to 1.26.6.
- CHANGELOG.md / FILELIST.md / READMEs (zh-TW / en / ja) updated.

## Risk

- **Low-medium** — comments and titles are easy to translate without
  breaking tests. Risk is mistakenly translating a fixture string that
  another assertion compares against. Mitigation: only touch lines clearly
  identified as comment / title / hint; preserve everything else.
