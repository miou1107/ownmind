# Tasks — v1.31.2 tasks the AI picks up

- [ ] `db/029_tasks.sql` — table, status check, indexes on (project, status), (claimed_by)
- [ ] `shared/task-body.js` — one normaliser for create/done bodies (caps, links shape)
- [ ] `src/routes/tasks.js` — factory router: create / list / claim / done / drop / review;
      visibility predicate in one place
- [ ] `src/jobs/*` — expire claims older than 24h (ride the daily cron)
- [ ] `mcp/index.js` + `mcp/lib/required-args.js` — five tools, session id on every call
- [ ] `src/routes/memory.js` — init carries `tasks` for the current project (≤5)
- [ ] `hooks/lib/render-session-context.js` — the Tasks block
- [ ] console: `pages/Portal/TasksPage.jsx` (mine), `pages/Team/TeamTasksPage.jsx` (admin+),
      nav, icons, zh/en/ja
- [ ] `docs/task-runner.md` — the scheduled-session recipe, with the `auto` tag convention
- [ ] `configs/CLAUDE.md`, `configs/ownmind-rules-block.md` — when to create a card, when to
      claim, never to review
- [ ] tests: normaliser, every route against a fake query (claim races, visibility), schema,
      context block, nav structure
- [ ] CHANGELOG, FILELIST, README ×3, version
- [ ] Deploy: migration 029, then tag
