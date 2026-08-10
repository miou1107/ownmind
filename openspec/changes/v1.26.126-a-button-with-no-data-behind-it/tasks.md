# v1.26.126 — Tasks

- [x] Write the failing tests first: parser shapes, description rules, route, packaging guard
- [x] `src/utils/changelog.js` — parse CHANGELOG.md into entries; `loadChangelogEntries`
      degrades to `[]` rather than throwing
- [x] `src/routes/changelog.js` — `GET /api/changelog` behind `auth`, parsed once at module load
- [x] `src/app.js` — mount `/api/changelog`
- [x] `Dockerfile` — `COPY CHANGELOG.md`, guarded by a test (IR-034)
- [x] `client/src/hooks/useChangelog.js` — fetch once per page load, cache successes only
- [x] `client/src/components/common/Layout.jsx` — call the hook; stop taking `changelog` as a prop
- [x] `client/src/App.jsx` — remove `layoutProps = { changelog: [] }`
- [x] `client/src/components/common/Footer.jsx` — `v` prefix on entry versions, omit an empty
      date, remove the copyright span
- [x] `client/src/i18n/{zh,en,ja}.json` — delete `footer.copyright` from all three
- [x] Visual check: footer bar and the opened modal, rendered from the real CHANGELOG.md
- [x] `npm test` green; version, CHANGELOG, FILELIST and the three READMEs updated
- [ ] Code review
- [ ] Deploy — Vin's call; the fix is invisible until the running server is rebuilt
