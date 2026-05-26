# v1.26.3 — i18n Phase 7: scripts/ Internal Comments to English (Track B)

## One-Line Summary

Translate all internal JSDoc + line comments in `scripts/` (314 lines across 21 files) to English. Continuation of v1.26.0/v1.26.2.

## In Scope

- `scripts/install-helpers/self-check.cjs` (97 lines)
- `scripts/reset-admin-password.js` (57)
- `scripts/update.sh` (54)
- `scripts/health-report-daily.sh` (49)
- `scripts/verify-upgrade.sh` (48)
- `scripts/interactive-upgrade.sh` (45)
- `scripts/run-migrations.sh` (35)
- 4 mid-sized scripts in `install-helpers/` (16-25 each)
- 10 small files (≤17 each)
- 2 test assertions updated (`reset-admin-password-script.test.js`, `add-stop-hook.test.js`) to match the translated CLI output / error messages.

## Out of Scope (Preserved on Purpose)

- `scripts/audit-real-iron-rules-lint.js` lines 71/75 — literal Chinese strings used to match
  the lintIronRule error messages (`'中英混雜'`, `'前 5 個'`). Functional; cannot translate
  without breaking the audit tool.

## Acceptance Criteria

- `rg '\p{Han}' scripts/` only returns the 2 preserved literals above
- `node --check` / `bash -n` pass for every file
- `npm test` passes (1956 / 0)
- `package.json` bumped to 1.26.3

## Risk

- **Low** — pure comment translation + 2 test assertion updates that follow the English
  versions of the translated CLI output.
