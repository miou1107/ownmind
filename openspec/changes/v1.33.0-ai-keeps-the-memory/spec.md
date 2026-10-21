# Spec — v1.33.0 the AI keeps the memory

Contracts first (every workstream builds against these), scenarios after.

## Contracts

### Migration `db/034_ai_keeps_the_memory.sql` (idempotent)

- `CREATE EXTENSION IF NOT EXISTS pg_trgm;`
- `memories`: constraint `memories_status_check` → `status IN ('active','disabled','archived')`;
  columns `archived_at TIMESTAMPTZ NULL`, `archived_reason TEXT NULL`;
  index `memories_trgm_idx` GIN on `lower(title || ' ' || content) gin_trgm_ops`.
- `memory_history`: constraint `memory_history_change_type_check` adds
  `'merge','archive','decide','restore'`.
- `session_lessons`: columns `reason TEXT NULL`, `promoted_by VARCHAR(20) NULL`
  (`'ai_repeat' | 'ai_monthly' | 'console'`).
- `tasks`: columns `evidence TEXT NULL`, `report_shown_at TIMESTAMPTZ NULL`.
- new table `consolidation_questions(id SERIAL PK, user_id INT NOT NULL, memory_id INT NOT NULL,
  project VARCHAR(255) NULL, question TEXT NOT NULL, asked_count INT NOT NULL DEFAULT 0,
  last_asked_at TIMESTAMPTZ NULL, answered_at TIMESTAMPTZ NULL, created_at TIMESTAMPTZ DEFAULT NOW())`.

### Similarity (`src/lib/memory-similarity.js`)

- `SIMILARITY_EXACT = 0.98`, `SIMILARITY_RELATED = 0.45`, `SIMILARITY_CANDIDATE = 0.6`,
  `LESSON_REPEAT = 0.6`.
- `normalizeForSimilarity(title, content)` → lower-cased, whitespace collapsed string.
- `findSimilarMemories(query, {userId, type, title, content, isTest})` →
  `{ exact: row|null, similar: [{id,title,similarity,excerpt}] }` using
  `similarity(lower(title||' '||content), $text)` over active rows of the same user, type and
  `is_test`; `similar` is the top 3 ≥ RELATED, ordered desc.

### Memory routes (new file `src/routes/memory-consolidation.js`, mounted at
`/api/memory/consolidation` **before** `/api/memory` so `/:id` never shadows it; the per-id
actions live in `src/routes/memory.js` next to `disable`)

| Route | Body | Result |
|---|---|---|
| `GET /api/memory/consolidation/candidates` | — | `{duplicates:[{a:{id,title,type,updated_at}, b:{…}, similarity}], concluded:[{id,title,marker,updated_at}], stale:[{id,title,updated_at,days}], waiting:[{id,title,project,created_at}], lessons:[{id,project,stuck,fix,next_time,created_at}], closed_tasks:[{id,project,title,done_at}]}` for the caller only |
| `POST /api/memory/consolidation/questions` | `{memory_id, question}` | 201 row; one open question per memory (second call updates the text) |
| `POST /api/memory/consolidation/questions/asked` | `{ids:[…]}` | increments `asked_count` at most once per Asia/Taipei day, always sets `last_asked_at`; `{updated:n}`; the hook sends it only on `startup`/`clear`, never on `resume`/`compact` |
| `PUT /api/memory/consolidation/report-shown` | `{task_id}` | sets `tasks.report_shown_at` on the caller's card; `{ok:true}` |
| `POST /api/memory/merge` | `{keep, drop}` | both active, same user and type; `drop` → `disabled`, `disabled_reason='merged into #<keep>'`, `disabled_at=NOW()`; `keep.metadata.merged_from` appends `drop`; history `'merge'` on both with `{keep, drop}`; returns `{keep: row, drop: row, sync_token}` |
| `POST /api/memory/:id/archive` | `{reason}` | type `project` only (409 `Only project memories can be archived`), active only; sets `archived`, `archived_at`, `archived_reason`; history `'archive'`; answers any open question of that memory; returns row + `sync_token` |
| `POST /api/memory/:id/restore` | — | `archived` → `active`, nulls `archived_*`; history `'restore'`; returns row + `sync_token` |
| `POST /api/memory/:id/decide` | `{decision, source_id}` | `source_id` exists for the same user and `created_at` is later than the target's (else 409 `source must be newer`); content becomes `決定（YYYY-MM-DD，依據 #<source>）：<decision>\n\n<old content>`; history `'decide'` with the old content; answers the open question; returns row + `sync_token` |

Shared types (`team_standard`, `coding_standard`) follow the same admin rule as `disable`.
Every write checks the sync token like `disable` does and returns a fresh one.

### Existing memory routes

- `POST /api/memory`: after the secret guard and before the insert, unless `force === true`:
  exact hit → `200 {saved:false, duplicate_of: row, sync_token}`; related hits → `200
  {saved:false, similar:[…], sync_token}`; otherwise insert as today (`201`).
  `is_test` rows only compare with `is_test` rows.
- `GET /api/memory/search`: `include_archived=1` widens the predicate to
  `status IN ('active','archived')`; each row carries `status`.
- `GET /api/memory/sync` with `since`: also returns rows where `archived_at > since`.
- `GET /api/memory/init` adds:
  - `handoffs: [{id, project, from_tool, from_machine, content, status, accepted_by, accepted_at}]`
    = every `pending` one plus those `accepted` in the last 30 minutes (`active_handoff` stays
    for older hooks).
  - `consolidation: { card: {id,title,status,created_at} | null, report: {task_id, month,
    merged, archived, decided, lessons_kept, closed_tasks} | null, questions: [{id, memory_id,
    project, question}] }` — `card` is the newest card in project `ownmind` whose title starts
    with `整理記憶 ` and status is `open` or `claimed`; `report` is the newest `done` such card
    with `report_shown_at IS NULL`, counts read from `memory_history` rows of that month and
    `tasks.done_at` of that month; `questions` are open ones with `asked_count < 2`, at most 3,
    oldest first.

### Lessons

- `storeSessionLessons` (`src/lib/session-lessons-store.js`): after inserting a lesson, look
  for another lesson of the same user, status `new` or `dismissed`, whose
  `similarity(lower(stuck||' '||fix), …) ≥ LESSON_REPEAT`. On a hit, create one `project`
  memory via `lessonToMemory` of the newer lesson with the line `（同一件事發生第二次）` added to
  the content, mark both lessons `promoted`, `promoted_by='ai_repeat'`, `memory_id` set.
  `POST /api/session` returns `lessons_promoted: [{lesson_id, memory_id}]`.
- `PUT /api/session/lessons/:id/set` `{status:'promoted'|'dismissed', reason?}`: `promoted`
  reuses the promote path (any status except `promoted`), `promoted_by='ai_monthly'` when the
  caller is the MCP (`x-ownmind-tool` header present) else `'console'`; `dismissed` stores
  `reason`. `GET /api/session/lessons` returns `reason`, `promoted_by`, `memory_id`.
- `/init.lessons_waiting` stays for older hooks; the hook no longer renders it.

### Tasks

- `PUT /api/tasks/:id/done`: body gains `evidence` (string, ≥ 20 chars after trim) — missing
  → `400 {error: 'evidence is required: the verification you ran and what it printed'}`.
  Stored in `tasks.evidence`.
- `PUT /api/tasks/:id/reopen` `{note?}`: owner or admin; `done` or `reviewed` → `open`,
  clears `claimed_*`, `result`, `evidence`, `done_at`, `reviewed_*`; appends
  `\n\n[reopened <ISO> by <name>] <note>` to body.
- `GET /api/tasks?mine=true` excludes `done` as well as `reviewed` and `dropped`.
- `me-overview` pending counts and the 待你處理 badge no longer count `done` cards.
- `PUT /:id/review` stays (older MCPs) but the console no longer calls it.

### Handoffs

- `PUT /api/handoff/:id/reopen`: `accepted` → `pending`, nulls `accepted_*`.

### Job `src/jobs/memory-consolidation.js`

- `runMemoryConsolidation({query, now})`: for each user with ≥ 1 active memory and no task in
  project `ownmind` titled `整理記憶 <YYYY-MM>` for `now`'s month (Asia/Taipei), insert one
  `open` card (`auto=true`, `is_private=true`) whose body is the candidate counts plus the
  two lines `規則照 ownmind-consolidate 這個 skill 做` and
  `先呼叫 ownmind_consolidation_candidates`. Also: questions with `asked_count ≥ 2`, unanswered,
  `last_asked_at` older than 14 days → archive the memory (`project` only) with reason
  `兩次未確認，自動歸檔`, mark the question answered.
- `startMemoryConsolidationJob()`: cron `10 4 * * *` Asia/Taipei, plus one run at start-up;
  wired in `src/index.js` with the other jobs.

### MCP (`mcp/index.js`)

| Tool | Args | Calls |
|---|---|---|
| `ownmind_consolidation_candidates` | — | GET candidates |
| `ownmind_merge` | `keep, drop` | POST merge |
| `ownmind_archive` | `id, reason` | POST archive |
| `ownmind_decide` | `id, decision, source_id` | POST decide |
| `ownmind_restore` | `id` | POST restore |
| `ownmind_ask_later` | `memory_id, question` | POST questions |
| `ownmind_lesson_set` | `id, status, reason?` | PUT lessons set |
| `ownmind_task_reopen` | `id, note?` | PUT tasks reopen |
| `ownmind_handoff_reopen` | `id` | PUT handoff reopen |

- `ownmind_save` gains `force` (boolean); on `saved:false` it returns the server body plus
  `notice`: for `duplicate_of` → `Already stored as #<id>; nothing was written.`; for `similar`
  → `Not saved: <n> related memories exist. Update the closest one with ownmind_update, or call
  ownmind_save again with force: true.`
- `ownmind_search` gains `include_archived` (boolean).
- `ownmind_task_done` requires `evidence`; its description says to run the card's verification
  first and pass the output. `ownmind_log_session`'s description no longer says the person
  promotes lessons in the console; it says the AI promotes repeats at once and the rest at the
  monthly pass. `ownmind_handoff_accept` unchanged.
- Every new action returns the server body plus a one-line `notice` the AI relays, ending in
  `要撤銷跟我說一聲`.

### Hooks

- `hooks/lib/render-session-context.js`:
  - Handoffs: for each pending handoff whose `project` matches the current project
    (`resolveProjectName()` result or the git remote repo name, case-insensitive; exact, or the
    shorter name equals the leading segments of the longer one split on `-`/`_`/space/`.`, so
    `nantou-funbus` matches `nantou-funbus-admin` but `api` never matches `fapa-api-gateway`)
    render `## Handoff to accept now (#id, from <machine>)`, its content, and the instruction to
    call `ownmind_handoff_accept` now and tell the person one line
    `已接手 <project> 的交接，要撤銷跟我說一聲`. Non-matching pending → one line per handoff:
    `你有一筆 <project> 的交接還沒接，在那個專案開對話就會接手`. Accepted within 30 minutes
    in the matching project → content with the note `另一個視窗 <n> 分鐘前接走`.
  - Consolidation: open card → `## Memory consolidation card #<id> is open` + the instruction
    to run it now in a background subagent (Agent tool) without blocking the person, starting
    with `ownmind_task_claim` and `ownmind_consolidation_candidates`, rules in the skill file.
    Report → one line `[OwnMind] <month> 的記憶整理完了：合併 N、歸檔 N、定案 N。要還原任何一條，說一聲。`
    and the hook calls `report-shown`. Questions → `## Questions for the person (ask at a natural
    moment, at most 3)` and the hook calls `questions/asked`.
  - The `Lessons waiting` section and the `Never mark one reviewed` sentence are removed; the
    task section says `done needs evidence`.
- `hooks/lib/sync-memory-files.js`: only `status === 'active'` rows enter the index and the
  files (allow-list). Index order: project memories whose tags contain the current project
  name (or `project:<name>`) or whose title contains it come first, then the rest by
  `updated_at` desc.
- User-facing strings go through `hooks/locales/zh.json` (+ en, ja, overrides) and the
  fallback test.

### Client

- Lessons page: lists `status=all` (last 60 days); no 留下 / 不留 buttons. Row shows the
  state (`AI 留下了` / `AI 沒留：<reason>` / `等月底整理`) and one button: promoted → 收回
  (archive its memory with reason `從教訓頁收回`), otherwise → 還是留 (set promoted).
- Task cards: no 審過; a `done` card shows 退回 (reopen) and its evidence. Team tasks page
  the same.
- Handoffs page: pending rows show `會在那個專案開對話時自動接手`; accepted rows (7 days) show
  who took it and 重開.
- Memory page: tab 已歸檔 (`GET /api/memory/archived` → archived rows of the caller, newest
  first, with `archived_reason`) with 還原 per row.
- `zh.json` is the source; en/ja entries added by hand with the parity tests green.

## Scenarios

### Archive and restore
- GIVEN an active `project` memory WHEN the AI calls `ownmind_archive` THEN the row is
  `archived`, it is absent from `/sync` (no since), `/init`, `/hook-context`, `/search` and the
  local index, present in `/search?include_archived=1` and `/api/memory/archived`, and a
  history row `archive` exists.
- GIVEN an archived memory WHEN restored THEN it is active again with a history row `restore`.
- GIVEN an iron rule WHEN archive is called THEN 409 and nothing changes.

### Merge
- GIVEN two active project memories WHEN merged THEN `drop` is `disabled` with reason
  `merged into #keep`, and `/sync?since=<before>` returns `drop` so clients remove it.

### Decide
- GIVEN memory A (created day 1) and memory B (created day 5) WHEN deciding A with source B
  THEN A's content starts with `決定（…，依據 #B）：`; WHEN deciding B with source A THEN 409.

### Save-time duplicate check
- GIVEN memory X WHEN saving the same title and content again THEN `saved:false`,
  `duplicate_of.id === X`, no new row.
- GIVEN the deploy checklist for 正式機 WHEN saving the 測試機 one THEN `saved:false` with X in
  `similar`, no new row; WHEN saving again with `force:true` THEN 201 and two rows exist.
- GIVEN no related memory WHEN saving THEN 201 as before.

### Lessons repeat
- GIVEN a `new` lesson "docker build 沒加 --no-cache 吃到舊層" WHEN a second session logs a lesson
  with the same stuck/fix wording THEN both are `promoted`, `promoted_by='ai_repeat'`, pointing
  at one new project memory, and the session response lists it.

### Tasks
- GIVEN a claimed card WHEN done is called without evidence THEN 400 and the card stays
  claimed; WITH evidence THEN done, and `mine=true` no longer lists it.
- GIVEN a done card WHEN the owner reopens it THEN it is open with the note in the body.

### Handoffs at session start
- GIVEN a pending handoff for project `nantou-funbus` WHEN a session starts in
  `~/SourceCode/line-summarizer-bot` THEN the context has only the one-line reminder; WHEN a
  session starts in `~/SourceCode/nantou-funbus` THEN the context carries the content and the
  accept instruction.
- GIVEN that handoff accepted 5 minutes ago WHEN a second session starts in `nantou-funbus`
  THEN the content is rendered with `另一個視窗 5 分鐘前接走`.

### Consolidation card
- GIVEN a user with active memories and no card for this month WHEN the job runs THEN exactly
  one open card `整理記憶 YYYY-MM` exists; WHEN it runs again THEN still one.
- GIVEN an open card WHEN a session starts THEN the context tells the AI to run it in a
  background subagent; GIVEN the card done and not yet shown WHEN a session starts THEN the
  one-line report is rendered once and `report_shown_at` is set.
- GIVEN a question asked twice and 14 days old WHEN the job runs THEN its `project` memory is
  archived with reason `兩次未確認，自動歸檔`.

### Local index
- GIVEN 300 project memories of which 12 are tagged `vinutes` WHEN the session starts in
  `~/SourceCode/Vinutes` THEN all 12 are in the index before any other project memory.
