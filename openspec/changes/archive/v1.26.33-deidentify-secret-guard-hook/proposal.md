# v1.26.33 — De-identify the pre-commit secret-guard (safety gap for non-IR-002 users)

## One-Line Summary

`hooks/ownmind-git-pre-commit.js` runs its staged-diff **secret content scan**
only when the blocking rule's code is literally `IR-002`
(`if (ruleCode === 'IR-002')`). For any user whose "do not commit secrets"
rule has a different number, the content scan never runs, so a secret pasted
into a normally-named file (e.g. `src/config.js`) is **not** caught and can be
committed.

## Why

- **Safety gap, not cosmetics.** Unlike the v1.26.32 display-labelling fix, this
  one lets real secrets through for every non-`IR-002` user.
- Same root cause / same class as v1.26.32 (product behavior keyed on one
  user's personal iron-rule number) and violates the same documented
  constraint (`shared/lint-event-types.js`): personal iron-rule codes must not
  appear in product code.

## Current State

- The secret-guard rule gets its verification from the semantic
  `commit_no_secrets` template (`src/utils/templates.js`), whose
  `conditions.type === 'staged_files_exclude'` — a signal **already stored** on
  every matched rule, keyed by template name, not by IR number.
- `evaluateConditions` runs the filename check (`staged_files_exclude`) for
  every commit-triggered rule regardless of code, so a staged `.env` **file**
  is blocked for anyone. The gap is only in the extra **content** scan
  (`checkStagedDiffForSecrets` → `detectSecretLike`), which is gated behind
  `ruleCode === 'IR-002'`.
- `hooks/lib/select-block-fingerprint.js` also keys its telemetry fingerprint
  categories on personal codes: `SECRET_RULE_CODES = ['IR-002']` (secret) and
  `IRON_RULE_QUALITY_CODES = ['IR-005','IR-006','IR-027']` (quality).

## Fix

1. New pure helper `hooks/lib/secret-guard-rule.js` →
   `isSecretGuardRule(verification)` returns
   `verification?.conditions?.type === 'staged_files_exclude'`. Semantic,
   testable, works for every user (existing rows included — the condition type
   is already stored), no migration.
2. `hooks/ownmind-git-pre-commit.js` — gate the content scan on
   `isSecretGuardRule(verification)` instead of `ruleCode === 'IR-002'`; add
   `isSecretRule` to each `blockReasons` entry for the fingerprint.
3. `hooks/lib/select-block-fingerprint.js` — the secret category keys on
   `r.isSecretRule === true || r.secretHit === true`; drop the personal
   `SECRET_RULE_CODES` set.

## What Changes

- Add `hooks/lib/secret-guard-rule.js` (+ unit test).
- `hooks/ownmind-git-pre-commit.js` — semantic gate + `isSecretRule` in reasons.
- `hooks/lib/select-block-fingerprint.js` — de-identify the secret category.
- Update `tests/git-pre-commit-fingerprint.test.js` secret cases to the
  semantic flag; add an integration reproduction case to
  `tests/pre-commit-secret.test.js` (non-IR-002 code + secret in content →
  still blocked).

## Non-Goals / Deferred

- **The quality fingerprint category** (`IRON_RULE_QUALITY_CODES` =
  IR-005/006/027) is telemetry-only and, on inspection, has no clean semantic
  signal on those rules (they carry no commit-triggered template). De-identifying
  it needs separate design; left to the planned personal-code sweep (B-class),
  not touched in this safety change.
- No change to the filename-exclude behavior (already code-agnostic).
- No data migration (the semantic signal is already stored).

## Release

Batched with v1.26.32 into a single tag + deploy (per Vin: avoid flooding users
with upgrade prompts). This change is client-side (`hooks/`), delivered when
users update `~/.ownmind`.
