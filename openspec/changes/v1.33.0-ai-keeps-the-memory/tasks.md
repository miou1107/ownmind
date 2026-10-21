# Tasks — v1.33.0 the AI keeps the memory

Four workstreams run in parallel against `spec.md`; each owns its files. Integration,
version bump, docs and release are the last stream.

## A — database and memory server (`db/`, `src/lib/memory-similarity.js`, `src/routes/memory.js`, `src/routes/memory-consolidation.js`, `src/lib/memory-sync.js`, `src/routes/session-lessons.js`, `src/lib/session-lessons-store.js`, `src/routes/session.js`, `src/routes/tasks.js`, `shared/task-body.js`, `src/routes/handoff.js`, `src/routes/me-overview.js`, `src/jobs/memory-consolidation.js`, `src/index.js`, `src/app.js`, tests for these)

- [x] migration 034
- [x] similarity helper + save-time check (`force`)
- [x] archive / restore / merge / decide routes with history and sync token
- [x] consolidation router: candidates, questions, questions/asked, report-shown
- [x] `/search include_archived`, `/sync since` includes archived, `/api/memory/archived`
- [x] `/init`: `handoffs`, `consolidation`
- [x] lessons: repeat promotion on insert, `set` route, reason/promoted_by
- [x] tasks: evidence on done, reopen, mine excludes done, overview counts
- [x] handoff reopen
- [x] job + wiring
- [x] tests (real-db for memory routes, scripted-query for factories)

## B — MCP (`mcp/index.js`, `mcp/lib/*`, `tests/tips-list.test.js`, other mcp tests)

- [x] nine new tools, `force`, `include_archived`, `evidence`, descriptions
- [x] notices on every new action
- [x] tests

## C — hooks (`hooks/lib/render-session-context.js`, `hooks/lib/sync-memory-files.js`, `hooks/lib/conditional-sync.js` if needed, `hooks/ownmind-session-start.js`, `hooks/lib/session-start-output.js`, `hooks/ownmind-session-start.sh`, `hooks/locales/*`, hook tests)

- [x] handoff project match, grace, reminders
- [x] consolidation card / report / questions, with the two mark calls
- [x] remove lessons-waiting section and the "never review" sentence
- [x] index allow-list and project-first order
- [x] locales zh/en/ja + fallback test entries
- [x] tests

## D — client (`client/src/pages/Portal/LessonsPage.jsx`, `TasksPage.jsx`, `HandoffsPage.jsx`, `client/src/pages/Team/TeamTasksPage.jsx`, `client/src/pages/Memory/*`, `client/src/components/common/nav-sections.js`, `client/src/i18n/*`, `tests/console-nav-structure.test.js`, client tests)

- [x] lessons page view + 收回 / 還是留
- [x] tasks: 退回 instead of 審過, evidence shown
- [x] handoffs: reminder text, 重開
- [x] memory 已歸檔 tab + 還原
- [x] i18n zh + en + ja, parity tests

## E — integration and release (after A–D)

- [x] the `ownmind-consolidate` skill (`skills/ownmind-consolidate.md`) (judgement rules) and `skills/ownmind-memory.md` / `configs/AGENTS.md` wording for handoffs, lessons, tasks
- [x] `npm test` green on the merged tree
- [x] version 1.33.0 in package.json and the three READMEs; CHANGELOG; FILELIST
- [x] proposal page for Vin updated to the reviewed design
- [ ] verification-before-completion, code review, PR

## Left for a later change

- The 待你處理 badge and the home page's 要你決定的事 still count pending handoffs and `new`
  lessons. Under this change neither waits for the person (the matching session accepts, the
  AI judges lessons), so both numbers should drop them; that touches the home overview and its
  "leaves off" arithmetic, which this change does not rework.
- `memories_trgm_idx` (GIN, pg_trgm) is not used by `similarity(...) >= x` predicates; at a few
  hundred memories per user the sequential scan is fine. Switch to the `%` operator with
  `pg_trgm.similarity_threshold` if a user's store grows past a few thousand rows.
