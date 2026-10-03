# Tasks — v1.31.0 lessons at close

- [x] `shared/session-lessons.js` — normaliser + `lessonToMemory`
- [x] `db/027_session_lessons.sql`
- [x] `mcp/lib/session-log-body.js` — carries normalised lessons
- [x] `mcp/index.js` — `lessons` in the tool schema and description; `lessons_notice` when absent
- [x] `src/routes/session.js` — POST stores lessons, scans each, reports saved/rejected
- [x] `src/routes/session-lessons.js` — list / promote / dismiss (factory, testable)
- [x] `src/app.js` — mounted before `/api/session`
- [x] `src/routes/memory.js` — init carries `lessons_waiting`
- [x] `hooks/lib/render-session-context.js` — the waiting line
- [x] console: `LessonsPage.jsx`, `App.jsx`, `nav-sections.js`, `Sidebar.jsx`, zh/en/ja
- [x] `configs/CLAUDE.md`, `configs/ownmind-rules-block.md`, `docs/setup-claude-code.md`
- [x] `tests/session-lessons.test.js`
- [x] CHANGELOG, FILELIST, version
- [ ] Deploy: run migration 027 on the server (`bash scripts/run-migrations.sh`), then tag
      v1.31.0 so clients update. Vin's call.
