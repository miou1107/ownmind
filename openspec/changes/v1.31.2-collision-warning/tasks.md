# Tasks — v1.31.2 collision warning

- [x] `db/029_edit_touches.sql` — table + index on (project, dir, last_seen)
- [x] `src/routes/activity-touch.js` — `POST /` (auth): upsert + answer `others`; `GET /overlaps` (adminAuth)
- [x] `src/jobs/touch-cleanup.js` — daily cleanup of rows older than 24h
- [x] `shared/touch-report.js` — path → { project, dir }; never a file name or home segment; the printed line
- [x] `hooks/lib/touch-state.js` — per-session cache (10-minute window, printed pairs)
- [x] `hooks/ownmind-touch-report.js` + `hooks/ownmind-iron-rule-check.js` — edit branch posts and prints; fail-open with a logged event
- [x] `client/src/pages/Team/OverlapsBlock.jsx` + `StatsPage.jsx` — the Overlaps block + i18n
- [x] tests: `tests/touch-report.test.js` — path mapping, cache window, server upsert/answer against a fake query, hook output,
      fail-open event, opt-out file, cleanup
- [x] CHANGELOG, FILELIST, README ×3, version
- [ ] Deploy: migration 029, then tag v1.31.2. Vin's call.

Decided against while building: a line in `hooks/locales/*.json`. The printed line is model-facing
(it asks the AI to tell the person in their language), so it stays English by the repo's own rule.
