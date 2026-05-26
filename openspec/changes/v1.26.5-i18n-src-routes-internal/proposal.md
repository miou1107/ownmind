# v1.26.5 — i18n Phase 9: src/routes/ Internal Comments + User-Facing Strings to English (Track B + A)

## One-Line Summary

Translate all JSDoc + inline comments AND user-facing HTTP error messages /
logger messages across `src/routes/` (24 files, ~1213 Chinese lines) to English.
Continuation of v1.26.0-v1.26.4. Per user decision (2026-05-26): thorough
translation including user-facing strings, with matching test assertion updates.

## In Scope

24 files under `src/routes/`:
- `memory.js` (194 lines) — biggest; lots of init / sync / CRUD endpoints
- `me.js` (176)
- `bug-reports.js` (80)
- `admin.js` (77)
- `activity.js` (75)
- `broadcast.js` (70)
- `usage/events.js` (57)
- `admin-iron-rule-upgrade.js` (55)
- `secret.js` (45)
- `setup.js` (37)
- `session.js` (33)
- `debug.js` (28)
- `usage/stats.js` (27)
- `admin-password-reset.js` (25)
- `me-narrative.js` (21)
- `usage/exemptions.js` (20)
- `usage/team-overview.js` (19)
- `usage/admin-clients.js` (18)
- `usage/pricing.js` (14)
- `usage/team-stats.js` (13)
- `handoff.js` (11)
- `admin-work-log.js` (9)
- `usage/admin-audit.js` (5)
- `export.js` (4)

Test assertion updates as needed when translated `res.json({ error: ... })`
strings break exact-match tests.

## Out of Scope (Preserved on Purpose)

- `memory.js` `team_standards_digest` prefix `'[團隊]'` — UI label rendered to
  users; bilingual on purpose.
- `memory.js` JSON-stringified `rule_title: '學到東西必須全層同步更新'` plus
  `context: '新增鐵律 ...'` / `'停用鐵律 ...'` — DB-persisted personal iron-rule
  title literal (known code smell; project_496 follow-up to convert to event-code
  lookup) and the audit-trail context strings stored alongside.
- `memory.js` `parent_title` SQL query against the literal `summary LIKE '週報%'`
  — matches Chinese summary text in `session_logs` rows written elsewhere.
- `memory.js` `由 ownmind-upload 自動建立的規範摘要: ${parent_title}` — the auto-
  generated content body for new team_standard parents; preserved in Chinese to
  match the localized convention of standard memos.

(Additional preserves will be documented during translation of each file.)

## Acceptance Criteria

- `rg '\p{Han}' src/routes/` only returns the preserved literals above.
- `npm test` passes (baseline 1956 / 0; some assertions updated for English
  error messages).
- `package.json` bumped to 1.26.5.

## Risk

- **Medium** — user-facing strings are tested in multiple places; expect to
  update several test assertions.
