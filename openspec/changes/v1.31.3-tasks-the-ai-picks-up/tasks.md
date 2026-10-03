# Tasks — v1.31.3 tasks the AI picks up

- [x] `db/030_tasks.sql` — table, status check, indexes on (project, status), (claimed_by)
- [x] `shared/task-body.js` — one normaliser for create/done bodies (caps, links shape)
- [x] `src/routes/tasks.js` — factory router: create / list / claim / done / drop / review;
      visibility predicate in one place; `expireStaleClaims`
- [x] `src/jobs/task-claim-expiry.js` — expire claims older than 24h (daily 03:20)
- [x] `mcp/index.js` — five tools, session id on every claim; init carries the project
- [x] `src/routes/memory.js` — init carries `tasks` for the current project (≤5)
- [x] `hooks/lib/render-session-context.js` — the Task cards block
- [x] console: `pages/Portal/TasksPage.jsx` (mine), `pages/Team/TeamTasksPage.jsx` (admin+),
      nav, icons, zh/en/ja
- [x] `src/app.js` mount, `src/index.js` job start
- [x] `docs/task-runner.md` — the scheduled-session recipe, with the `auto` tag convention
- [x] `configs/CLAUDE.md`, `configs/ownmind-rules-block.md`, `docs/setup-claude-code.md`
- [x] tests: `tests/tasks.test.js` — normaliser, every route against a fake query (claim races,
      visibility), schema, context block; nav structure test covers the two pages
- [x] CHANGELOG, FILELIST, README ×3, version
- [ ] Deploy: migration 030, then tag v1.31.3. Vin's call.

Numbering: planned as v1.31.2 with migration 029; another release took v1.31.1 and migration 028
while this was built, so it ships as v1.31.3 with migration 030.
