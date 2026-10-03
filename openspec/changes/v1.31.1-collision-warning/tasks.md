# Tasks — v1.31.1 collision warning

- [ ] `db/028_edit_touches.sql` — table + index on (project, dir, last_seen)
- [ ] `src/routes/activity.js` — `POST /touch` (auth): upsert + answer `others`
- [ ] `src/jobs/*` — daily cleanup of rows older than 24h (ride the existing cron)
- [ ] `shared/touch-report.js` — path → { project, dir }; never a file name or home segment
- [ ] `hooks/lib/touch-state.js` — per-session cache (10-minute window, printed pairs)
- [ ] `hooks/ownmind-iron-rule-check.js` — edit branch posts and prints; fail-open with a logged event
- [ ] `hooks/locales/{zh,en,ja}.json` — the printed line, zh as source
- [ ] `src/routes/activity.js` — `GET /stats/overlaps` (adminAuth) for the team page
- [ ] `client/src/pages/Team/StatsOverview.jsx` — the Overlaps block + i18n
- [ ] tests: path mapping, cache window, server upsert/answer against a fake query, hook output,
      fail-open event, opt-out file
- [ ] CHANGELOG, FILELIST, README ×3, version
- [ ] Deploy: migration 028, then tag
