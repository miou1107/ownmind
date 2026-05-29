# v1.26.18 — i18n Phase: src/ remaining files Internal English (Track B)

## One-Line Summary

Translate Chinese comments + confirmed internal messages to English across the
~43 remaining `src/` files (the iron-rule family was done in v1.26.15). Continuation
of Track B. User-facing API messages, the LLM prompt, and human-facing rendered
report content are explicitly preserved (they belong to Track A, which needs a
backend i18n base that does not exist yet).

## Background

A scan of the remaining src files found Chinese split into:
- **Comments** (the large majority across ~43 files) — safe to translate.
- **Non-comment Chinese** — falls into safe vs must-preserve:
  - SAFE: internal / AI-facing messages, log lines not shown to end users.
  - PRESERVE (decided with user):
    - `lib/llm-narrative.js` SYSTEM_PROMPT — a Chinese prompt that directs the AI's
      report output and explicitly requires Traditional-Chinese output; translating
      changes model behaviour.
    - User-facing API error strings in `routes/me.js`, `routes/admin.js`,
      `routes/setup.js`, `routes/activity.js`, `routes/bug-reports.js`,
      `routes/admin-password-reset.js`, `routes/session.js` — shown to the human
      user; translating would surface English errors to Chinese users (Track A).
    - Human-facing rendered report/template content in `jobs/weeklyReport.js`,
      `utils/templates.js`, and any digest/notification text shown to users.
    - Any regex/array Chinese used to match user content.

## In Scope — translate to English

- All comments (JSDoc + `//` + `/* */`) across the ~43 files.
- Non-comment strings ONLY when verified to be internal / AI-facing / dev logs
  not shown to an end user.

Low-risk files (almost entirely comments — translate freely): `semver.js`,
`syncToken.js`, `run-migrations.js`, `report.js`, `pricing-lookup.js`,
`enrich-activity.js`, `activity-insert.js`, `usage-aggregation.js`,
`broadcast-filter.js`, `first-run-redirect.js`, `bug-report-spam-detector.js`,
`constants.js`, `auto-numbering.js`, `session-query.js`, `crypto.js`, `db.js`,
`md-parser.js`, `require-fields.js`, `memory-secret-guard.js`, `app.js`, and similar.

Risk files (many non-comment lines — translate comments only, judge each
non-comment line, preserve user-facing/prompt/render): `routes/me.js`,
`routes/admin.js`, `lib/llm-narrative.js`, `jobs/weeklyReport.js`,
`utils/templates.js`, `utils/memory-error-classifier.js`,
`jobs/nightly-upgrade-reminder.js`, `routes/setup.js`, `routes/activity.js`,
`routes/bug-reports.js`.

## Out of Scope — preserved on purpose

- The `llm-narrative.js` SYSTEM_PROMPT (functional Chinese prompt).
- User-facing API error strings (Track A; backend has no i18n mechanism yet).
- Human-facing rendered report/template content.
- Regex/array Chinese that matches user content.

## Safety constraints (same as v1.26.15)

- Translate ONLY comments and verified-internal string content. NO identifier renames.
- Edit in place, surgically. Translate one file, run `npm test`, then move on.
- Compare the pass COUNT (baseline 2012 / 0 fail / 0 skipped), not just "green".
- `git diff` self-check after each file.

## Verification

- `npm test` must stay at the 2012/0/0 baseline. Any test asserting a translated
  Chinese substring gets its assertion updated to English in the same batch.

## Out-of-scope follow-ups

- A later release — `tests/` developer-facing Chinese (Track B).
- Track A — backend message i18n + iron-rule-file render migration.
