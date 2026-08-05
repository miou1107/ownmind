# v1.26.34 — Guard against personal iron-rule codes in product code (B-class sweep)

## One-Line Summary

~80 stray personal iron-rule code references (`IR-NNN`) had accumulated across
product code — comments, help/SOP text, schema descriptions, display strings,
and one functional fingerprint heuristic. Each is wrong for any user whose rule
#N is something different, and all violate the project's own rule that personal
iron-rule codes must not appear in product code. This change removes them all
and adds a guard test so the drift cannot silently return.

## Why

- Closes the last, broad instance of the same class fixed functionally in
  v1.26.32 (compliance loop) and v1.26.33 (secret guard): personal iron-rule
  numbers baked into product code.
- Reminders had failed to keep the codebase clean (the drift proves it), so the
  fix is *logic, not a reminder* — a test that fails on any concrete `IR-\d`
  code in scanned product code. (The "logic over reminders" principle applied
  to the codebase itself.)

## Current State (before)

- ~80 `IR-NNN` references across 28 files in src/mcp/hooks/shared/client-src.
- The vast majority are comments referencing a specific rule by meaning
  (e.g. `// IR-027 logic over reminders`).
- A handful are generic teaching examples (`e.g. IR-001`, tip text).
- Three are functional: `hooks/lib/select-block-fingerprint.js` keyed a
  telemetry "quality" fingerprint category on a hardcoded list
  `['IR-005','IR-006','IR-027']`.

## Fix

1. **Guard test** `tests/no-personal-rule-codes.test.js`: scans product dirs and
   fails on any `IR-\d{2,4}` (case-insensitive). Generic examples must use the
   digit-free placeholder `IR-XXX`. One justified allowlist entry: the
   documented `LEGACY_FULL_LAYER_SYNC_CODE = 'IR-006'` in me.js (matches
   historical prod rows; a destructive migration is out of scope).
2. **Comments / help text / schema descriptions**: reworded to describe the
   rule's purpose without the number; generic examples → `IR-XXX`.
3. **Functional**: removed the personal-code "quality" fingerprint category
   (unreachable — those rules carry no commit-triggered verification, and the
   list did not match the real commit-time quality rule). Quality-process blocks
   now bucket as the generic `clt_user_reported_other` (a registered
   fingerprint). Also neutralized "Vin 的鐵律" → "你的鐵律" in the
   commit-msg hook's user-facing message.

## What Changes

- New `tests/no-personal-rule-codes.test.js` (guard).
- 28 product files de-identified (comments/strings only, except the fingerprint
  removal).
- `hooks/lib/select-block-fingerprint.js` — remove the personal-code quality
  category; `tests/git-pre-commit-fingerprint.test.js` updated accordingly.
- `hooks/ownmind-git-commit-msg` + `tests/git-hook-co-authored-by.test.js` —
  neutralized label + assertion.

## Non-Goals / Deferred

- **Personal NAMES in generated output** ("Vin" in iron-rule-sync.js /
  iron-rule-suggest.js SKILL.md generation) — a separate name-de-identification
  axis needing a product decision; spawned as a follow-up task.
- No behavior change beyond the fingerprint category removal.

## Release

Batched with v1.26.32 + v1.26.33 into a single tag + deploy (per Vin: one
user-facing upgrade).
