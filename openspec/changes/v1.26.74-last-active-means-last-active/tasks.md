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

One round against a non-git copy outside the repo. Four findings: one fixed, one kept and
explained, two confirming the change was right.

The fix ships as **v1.26.75** rather than being folded back into v1.26.74: the pre-commit
gate requires a code change to carry a version, and v1.26.74 was already written into
CHANGELOG and the three READMEs by the time the review came back. Same change folder,
because it is the same piece of work.

- [x] **The extra sources were read once per work log, not once per person.** The sharpest
      one and correct. Two `LEFT JOIN LATERAL`s sat after `JOIN session_logs`, so each was
      evaluated for every work-log row inside the window — 50 sessions in a period meant
      50 `MAX(ts)` lookups per source, against `token_events`. Rewritten as scalar
      subqueries in the select list, which run once per output group, and `ORDER BY` now
      names the output column so neither subquery is evaluated twice. This also removed
      `act.last_ts` / `tok.last_ts` from the `GROUP BY`, which the reviewer separately
      flagged as leaning on data being constant per user.
- [x] **`activity.js` does not bound `last_active` by the window while its counts are
      bounded.** True, deliberate, and now said out loud in the code rather than left to
      be read as an oversight. That page lists everybody, so the column has always meant
      "when did we last hear from this person at all"; bounding it would blank the answer
      for exactly the people somebody opens the page to find. 團隊用量 bounds all three
      because it only lists people who worked inside the chosen period at all.
- [x] **The `GROUP BY` was legal and `GREATEST`'s NULL handling correct** — confirmed,
      no action. The rewrite removed the question anyway.
- [x] **Parameterisation is clean** — `$1`/`$2` throughout, no interpolation.

Process note: `agy -p` ignores the shell's working directory. The first run spent fifteen
minutes looking for the files in its own install directory and answered "I cannot find
them", which reads at a glance like a review that found nothing. It needs `--add-dir` plus
absolute paths in the prompt.

## Phase 6 — Sync

- [x] `package.json` 1.26.74, `README.md` ×3
- [x] `CHANGELOG.md`, `FILELIST.md`
- [x] `FILELIST.md` had drifted: the version log stopped at v1.26.64 while ten versions
      shipped, and two entries from v1.26.73/74 had been filed into the v1.26.50 section
      by mistake. Consolidated section added for v1.26.65–74, the two strays moved, and
      eight files that existed nowhere in the tree (db/019 and seven test files) added.
