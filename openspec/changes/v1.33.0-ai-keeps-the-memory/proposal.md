# v1.33.0 — the AI keeps the memory; the console only shows and undoes

## Why

On 2026-10-21 Vin rejected a console page where he would press "merge" or "archive"
per memory: nobody opens the console to do that, which is why 155 iron rules and 374
project memories piled up with duplicates and finished items still active. He set the
product rule (CLAUDE.md, inference 5): maintaining the memory store is the AI's job. A
feature that only works once the person presses something in the console is redesigned so
the AI does it; the console shows what the AI did and lets the person undo it.

The same day he asked whether the console should lose some of its pages. No page is
removed: three places still wait for a person to press a button, and each is turned
around so the AI acts and the console only shows and undoes:

| Console page | Today | After |
|---|---|---|
| Lessons | each lesson waits for 留下 / 不留 | the AI promotes a lesson on its second occurrence or at the monthly pass; the page shows what it kept and why, with undo |
| Task cards | done waits for 審過 | done with evidence closes the card; the monthly report lists closed cards; reopen from the chat or the page |
| Handoffs | waits for 接手 | the next session in the same project accepts it; other projects only see a one-line reminder |

An adversarial review of the first draft (2026-10-21, a second model) changed twelve
points of the design; they are folded in below and listed at the end.

## What changes

### 1. Memory states: `archived` is a third state, distinct from `disabled`

- `disabled` keeps its meaning: this memory is wrong or superseded. Never searchable.
- `archived` is new: the thing this memory describes has ended, and what it says was true
  at the time. Only `project` memories can be archived. Archived memories leave the local
  index, the sync payload and the default search; `ownmind_search` gains
  `include_archived` for history questions.
- A duplicate that loses a merge is `disabled` with `disabled_reason` "merged into #N"
  (not archived), so it can never come back as a valid historical fact.
- Every merge, archive, decide and restore writes a row in the memory history, so the
  console can show it and `revert` can undo it.

### 2. Save-time duplicate check (server side, no model)

`POST /api/memory` runs two checks before inserting:

1. **Exact duplicate**: same user, same type, normalised title+content trigram similarity
   ≥ 0.98 → the server does not insert; it returns the existing row with `duplicate_of`
   set and `saved: false`. Idempotent, no AI decision needed.
2. **Related memories**: the top 3 active memories of the same type whose trigram
   similarity on title+content is ≥ 0.45 → the server does not insert; it returns
   `similar: [{id, title, similarity, excerpt}]` and `saved: false`. The MCP tool relays
   them and the AI decides: `ownmind_update` the closest one, or call `ownmind_save`
   again with `force: true`. The AI has the subscription model; the server has none.

Thresholds are constants with tests that show the worst case: two deploy checklists that
differ only in 正式機/測試機 and an IP do **not** collapse into one (they land in
`similar`, never in `duplicate_of`).

### 3. Monthly consolidation: a task card, candidates from the server, judgement in the AI

- A server job runs daily at 04:10 and, when the month has no consolidation card yet,
  creates one task card `整理記憶 YYYY-MM` in project `ownmind` per user with ≥ 1 active
  memory. The card body carries the candidate counts and the link to the rules skill.
- `GET /api/memory/consolidation/candidates` returns three groups, computed in SQL:
  - **duplicates**: pairs of active memories of the same type with trigram similarity ≥ 0.6
  - **concluded**: `project` memories whose *title* starts or ends with one of
    【已過時】【已結案】【已完成】【已發】【已合併】【已關單】(also without brackets), plus
    `project` memories not updated for 90 days (flagged `stale`, never auto-archived)
  - **waiting**: active memories whose title or first line contains 待決定／待確認／待執行／
    等…回覆 (flagged only; the AI must find the answer in memories *created after* the
    waiting one and cite the source id)
- The AI works the card with four new MCP actions, each writing its own history row and
  appending a progress line to the card, so a run that stops half-way leaves a readable
  trail and the next run continues:
  - `ownmind_merge({keep, drop})` — `keep` stays active; `drop` becomes `disabled` with
    reason "merged into #keep"; when the two conflict, the newer wins and the older text
    goes to history, not into the kept body.
  - `ownmind_archive({id, reason})` — `project` only.
  - `ownmind_decide({id, decision, source_id})` — prepends `決定（YYYY-MM-DD，依據 #source）：…`;
    `source_id` must be newer than `id`. One-off items are then archived by the AI;
    standing decisions stay active and the AI removes 待決定 from the title.
  - `ownmind_restore({id})` — archived → active (the console 還原 button calls the same
    route).
- The judgement rules (what to do yourself, what to check on the machine first, what to
  ask) live in the `ownmind-consolidate` skill (`skills/ownmind-consolidate.md`), linked from the card. Rule of
  thumb from the review: before asking the person whether something is still running or
  installed, check git log, the file system or the server; ask only about things outside
  the machine (did Adam open the API, was the form resent). A "not done yet" item becomes
  a task card, not a memory that is asked about every month.
- Who runs it: the session-start context says, when the user has an open consolidation
  card, "run it now in a background subagent; do not block the person". Vin's own
  machines may also start it from a scheduled Claude Code run; the server does not care
  which session picks it up. The first month runs only the title-marked archives and the
  exact duplicates; the 90-day rule stays flag-only until the second month.
- Reporting: when the card is done, the session-start context carries one line
  (`[OwnMind] 10 月的記憶整理完了：合併 2、歸檔 18、定案 5。要還原任何一條，說一聲。`)
  once, then marks it shown. No reply-lint gate forces it into the first sentence: the
  review showed that gate would hijack an emergency session.
- Questions: at most three, delivered only in a session whose project matches the
  memory's project (memories without a project go to any session). A question shown twice
  without an answer is archived with the note 「兩次未確認，自動歸檔」 and listed in the
  next report; it never blocks newer questions.

### 4. Lessons: the AI promotes, the console shows

- `ownmind_log_session` with `lessons` stores them as `new` as today. Two promotions
  happen without a person:
  - **repeat**: on insert, if a `new` or `dismissed` lesson of the same user with trigram
    similarity ≥ 0.6 exists, both are promoted into one `project` memory (stuck/fix/
    next-time text of the newer one, "seen twice" in the body) and both rows point at it.
  - **monthly**: the consolidation card lists `new` lessons older than 7 days; the AI keeps
    the ones still true and not already fixed in code or CLAUDE.md, dismisses the rest with
    a one-line reason (`ownmind_lesson_set({id, status, reason})`).
- The session-start reminder "lessons are waiting on the console" is removed.
- Console lessons page: no 留下 button. It shows kept / dismissed with the reason, and
  one action per row: 收回 (archive the memory it made) or 還是留 (promote now). Both call
  routes the MCP also exposes.

### 5. Task cards: done with evidence closes the card

- `PUT /:id/done` requires `evidence`: the verification the AI actually ran and its output
  (≥ 20 characters). A done call with only a method and no result is refused with a
  sentence saying what to pass.
- `done` is terminal. `reviewed` stays as a value for old rows; the console 審過 button
  goes. `PUT /:id/reopen` (owner or admin) sets the card back to `open` with a note; MCP
  `ownmind_task_reopen` calls it.
- The monthly report lists cards closed in the month.

### 6. Handoffs: the matching project accepts

- The session-start hook compares the pending handoff's `project` with the current
  working directory's project name (folder basename, case-insensitive, also matching the
  git remote repo name). Match → the context tells the AI to accept it now with
  `ownmind_handoff_accept` and carries the content. No match → one line: 「你有一筆
  <project> 的交接還沒接，在那個專案開對話就會接手」.
- For 30 minutes after an accept, a second session in the same project still receives the
  content, marked 「另一個視窗 N 分鐘前接走」, so a test window cannot swallow it.
- `PUT /:id/reopen` and MCP `ownmind_handoff_reopen` put a handoff back to pending.

### 7. Local index: the current project first

`render-session-context` orders the 140-line local index so that memories tagged with the
current project come first (all of them), then the rest by `updated_at` desc. This is the
change that actually fixes "the memory I need is in the 220 lines that did not fit"; the
monthly pass keeps the search results clean, it does not fix the index on its own.

### 8. Undo from the chat, every time

Every automatic action the AI takes (promoted a lesson, closed a card, accepted a handoff,
merged/archived a memory) returns a one-line notice the AI relays, ending with 「要撤銷跟我
說一聲」, and every console undo button has an MCP twin:
`ownmind_restore`, `ownmind_lesson_set`, `ownmind_task_reopen`, `ownmind_handoff_reopen`.

## Not in this change

- Semantic (embedding) similarity: the server has no model; trigram similarity plus the
  AI's reading of the `similar` list covers it.
- Archiving iron rules, team standards or preferences: never automatic.
- A cloud scheduler inside OwnMind: the card is the schedule; any session runs it.

## Points changed by the adversarial review (2026-10-21)

1. Losing duplicates and outdated items are `disabled`, not `archived`.
2. Two-tier duplicate check; near-duplicates are returned, not auto-updated.
3. Decisions cite a newer source id; standing decisions stay active.
4. No central scheduler dependency; the card is picked up by any session; progress is
   written per action.
5. No reply-lint gate on the first sentence; questions go to the matching project and
   expire after two unanswered showings.
6. Project-first local index added.
7. Merge conflicts: newer wins.
8. Auto-archive only on title markers, `project` type only.
9. Lessons promote on repeat or at the monthly pass, not at log time.
10. Done needs evidence; reopen exists.
11. Handoff auto-accept is project-scoped with a 30-minute grace.
12. Every console undo has an MCP twin and a chat notice.
