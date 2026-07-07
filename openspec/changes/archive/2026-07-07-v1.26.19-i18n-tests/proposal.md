# v1.26.19 — i18n Phase: tests/ comments + descriptions Internal English (Track B)

## One-Line Summary

Translate Chinese `//` / `/* */` comments and `describe`/`it`/`test` description
strings to English across the `tests/` directory. Continuation of Track B
(developer-facing internal English). Assertion expected-values, fixtures
simulating user Chinese input, and any test data are explicitly preserved.

## Background

A scan of `tests/` found ~1222 Chinese lines, split into:
- **Comments** (`//`, `/* */`, JSDoc) — developer-facing, safe to translate.
- **`describe`/`it`/`test` description strings** — developer-facing test labels;
  node:test uses them only as report labels, so translating them is execution-safe.
- **Assertion expected-values** (`assert.equal(..., '需要管理員權限')` etc.) — these
  match product Chinese strings that v1.26.18 deliberately preserved; translating
  would break the test or decouple it from the product. PRESERVE.
- **Fixtures simulating user Chinese input / test data** — user-data category.
  PRESERVE.

User decision (this change): translate ONLY comments + describe/it/test
descriptions. Do NOT touch assertion values, fixtures, or test data.

## In Scope — translate to English

- All Chinese in `//` and `/* */` / JSDoc comments.
- The description string argument of `describe(...)`, `it(...)`, `test(...)`.

## Out of Scope — preserved on purpose

- Assertion expected-values (anything compared against product output).
- Fixtures simulating user Chinese input.
- Any other string literal / test data.

## Safety constraints

- Translate ONLY comments and describe/it/test descriptions. NO identifier renames.
- NEVER change a string that is passed to an assertion or used as test data.
- Edit in place, surgically. Batch files, run `npm test` per batch.
- Compare the pass COUNT (baseline 2012 / 0 fail / 0 skipped), not just "green".
- `git diff` self-check after each batch: only comments / describe-it-test labels changed.

## Verification

- `npm test` must stay at the 2012/0/0 baseline throughout.
- Because the change touches only comments and test labels, the pass count must
  remain identical; any change in count signals an accidental edit to test logic.

## Out-of-scope follow-ups

- Track A — backend message i18n + iron-rule-file render migration.
