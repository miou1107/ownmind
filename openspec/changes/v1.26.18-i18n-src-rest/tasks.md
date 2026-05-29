# Tasks — v1.26.18 i18n src/ remaining files (Track B)

## Safety constraints (apply to EVERY edit)

- Translate ONLY comments and verified-internal string content. NO identifier renames.
- Edit in place, surgically; never full-file rewrites.
- Translate one file, run `npm test`, then move on.
- Compare pass COUNT (baseline 2012 / 0 fail / 0 skipped), not just "green".
- `git diff` self-check after each file: only comments / verified-internal strings changed.
- For any non-comment Chinese: confirm it is internal/AI-facing/dev-log before
  translating. If user-facing / prompt / rendered-to-human / matches user content,
  PRESERVE it.

## Phase 0: Baseline

- [x] `npm test` fully green; record pass count (expected 2012).

## Phase 1: Translate — low-risk files first (comments-dominant)

- [x] Batch A (utils, comments-dominant): semver, syncToken, run-migrations, report,
      pricing-lookup, enrich-activity, activity-insert, auto-numbering, constants,
      crypto, db, md-parser, require-fields, memory-secret-guard.
- [x] Batch B (jobs/lib/middleware, comments-dominant): usage-aggregation,
      broadcast-filter, session-query, first-run-redirect, bug-report-spam-detector,
      seed-default-passwords, nightly-recompute, memory-sync, adminAuth, index.
- [x] Batch C (app.js + auth middleware): app.js, auth.js.

## Phase 2: Translate — risk files (comments only; preserve non-comment per scope)

- [x] `lib/llm-narrative.js` — comments only; PRESERVE the SYSTEM_PROMPT.
- [x] `routes/me.js`, `routes/admin.js`, `routes/setup.js`, `routes/activity.js`,
      `routes/bug-reports.js`, `routes/admin-password-reset.js`, `routes/session.js`,
      `routes/memory.js` — comments only; PRESERVE user-facing API error strings.
- [x] `jobs/weeklyReport.js`, `jobs/nightly-upgrade-reminder.js` — comments only;
      PRESERVE human-facing rendered report content.
- [x] `utils/templates.js`, `utils/memory-error-classifier.js`, `utils/bug-report-helpers.js`
      — comments + verified-internal only; PRESERVE rendered/user-facing content.

## Phase 3: Verify

- [x] Full `npm test` matches baseline (2012/0/0).
- [x] Any red test on a translated Chinese substring -> update the assertion to English, re-run.
- [x] Scan src (excluding iron-rule family): confirm only intended Out-of-Scope Chinese remains.

## Phase 4: Quality gates + release

- [x] verification-before-completion (evidence: green test output).
- [x] requesting-code-review (reviewer on the diff).
- [x] receiving-code-review (act on findings).
- [x] Version sync: package.json 1.26.17 -> 1.26.18, CHANGELOG entry, tag v1.26.18.
- [x] Update FILELIST (add this proposal; iron-rule family file descriptions unchanged).
- [x] Commit (no Co-Authored-By). Tag. Push when user approves.
