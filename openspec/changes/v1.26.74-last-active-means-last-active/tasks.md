# v1.26.74 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Find out what the column actually reads

- [x] `last_active_at` in `src/routes/usage/team-overview.js` was
      `MAX(session_logs.created_at)`, and the sort used the same expression.
- [x] `session_logs` has exactly one writer: the `ownmind_log_session` MCP tool, whose own
      description says it must be called "before a conversation ends". Nothing else in the
      product inserts into that table, so there is no second path that could keep the
      column moving mid-session.
- [x] Three candidate sources exist and each has a different delay. Only `token_events`
      moves while somebody is still working, and its `ts` is the **message** timestamp,
      not the ingest time — so the scanner's schedule affects when a value appears, never
      what it says.
- [x] `統計儀表板` (`src/routes/activity.js`) answers the same question from
      `MAX(activity_logs.ts)` alone. Milder, same shape: a long coding session may never
      call an ownmind tool.

## Phase 1 — Ask before implementing

- [x] Two ways to make the column honest: rename it to 最近記錄, or change what it reads.
      Vin chose the data on 2026-08-06. Renaming would have been accurate and would still
      have left nobody able to see who is working right now.

## Phase 2 — RED

- [x] `tests/team-overview-last-active.test.js`, 7 tests: the three sources are present,
      each is bounded by the same window, the sort uses the displayed expression,
      membership is still `JOIN session_logs`, the value passes through, a bad range still
      400s before any query, and `activity.js` reads the same three.

## Phase 3 — GREEN

- [x] `team-overview.js` — `GREATEST(MAX(sl.created_at), act.last_ts, tok.last_ts)` with
      two `LEFT JOIN LATERAL` subqueries, both bounded by `$1`/`$2`, and the same
      expression in `ORDER BY`. `GROUP BY u.id, u.name, act.last_ts, tok.last_ts`: each
      lateral returns exactly one row per user, so nothing multiplies.
- [x] `activity.js` — the same three sources, lifetime-scoped as that column always was,
      `NULLS LAST` kept so a member with no history still sorts to the bottom.

## Phase 4 — Verify

- [x] Full suite: 2945 tests, 2943 pass, 0 fail, 2 skipped.
- [x] Index check before shipping a per-user subquery: `ix_token_events_user_day
      (user_id, ts)` and `idx_activity_logs_user_ts (user_id, ts)` both exist, so each
      lateral is an index scan rather than a table scan. `session_logs` has `(user_id)`
      only; that table holds one row per conversation and the scan is bounded by it.

## Phase 5 — Review

- [x] One round against a non-git copy outside the repo.

## Phase 6 — Sync

- [x] `package.json` 1.26.74, `README.md` ×3
- [x] `CHANGELOG.md`, `FILELIST.md`
- [x] `FILELIST.md` had drifted: the version log stopped at v1.26.64 while ten versions
      shipped, and two entries from v1.26.73/74 had been filed into the v1.26.50 section
      by mistake. Consolidated section added for v1.26.65–74, the two strays moved, and
      eight files that existed nowhere in the tree (db/019 and seven test files) added.
