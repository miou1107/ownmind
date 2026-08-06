# v1.26.76 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Found by deploying

- [x] v1.26.75 deployed to production 03:16, 2026-08-06. Migrations 018 and 019 applied
      cleanly, container reported 1.26.75, key confirmed as
      `(user_id, tool, machine)`. Then the log line: `heartbeat update failed
      {"error":"inconsistent types deduced for parameter $2"}`, repeating.
- [x] Traced to the v1.26.73 rewrite of the heartbeat write from `INSERT ... VALUES` to
      `INSERT ... SELECT ... WHERE`. The defect has been in the code since v1.26.73 and
      could only ever appear against a real database.

## Phase 1 — RED

- [x] `tests/heartbeat-per-machine.test.js` — every parameter in the select list must
      carry a cast. Failed before the fix.
- [x] First version of the assertion was wrong for an amusing reason: it sliced from the
      first `SELECT` after the INSERT, which landed inside the new comment explaining the
      rule, and that comment quotes the error message containing `$2`. The test failed on
      its own prose. Strips SQL comments now.

## Phase 2 — GREEN

- [x] `src/routes/usage/events.js` — `$1::int`, and `::varchar` on the rest.
- [x] Backticks kept out of the SQL comment. A backtick inside a comment inside a template
      literal closes the literal; this is the second time in this line of work.

## Phase 3 — Verify, and not only with our own tests

- [x] Mutation check: remove one cast → red, restore → green.
- [x] `PREPARE` the **uncast** statement against the production database: reproduces
      `inconsistent types deduced for parameter $2`, `DETAIL: text versus character
      varying`. The diagnosis is measured, not inferred.
- [x] `PREPARE` the **cast** statement against the same database: accepted.
- [x] Swept for the same shape elsewhere: one other `INSERT ... SELECT` with parameters,
      `broadcast.js:343`. Each of its parameters appears once, so there is no conflicting
      deduction; `PREPARE`d it too rather than reasoning about it. Accepted, left alone.
- [x] Full suite.

## Phase 4 — Sync

- [x] `package.json` 1.26.76, `README.md` ×3, `CHANGELOG.md`, `FILELIST.md`

## Phase 5 — Deploy and confirm on the thing that failed

- [x] Production rebuilt and restarted on v1.26.76, 03:24 on 2026-08-06. Zero
      `heartbeat update failed` lines since.
- [x] **Positive control, because a quiet log is not evidence.** Read this account's five
      heartbeat rows (02:53–03:03), ran the installed scanner, read them again: all five
      at 03:26:25. The write works; the silence was not a second way of failing.
- [x] Browser check of both pages this line of work touched:
      - 團隊用量 — 最近活動 for a person working right now reads the current minute, which
        is the entire point of v1.26.74. Others in the team show times inside their live
        sessions rather than when those sessions began.
      - 系統設定 — the column is grouped by computer, headed 各電腦的工具版本 / 最後
        heartbeat, with the OS beside the machine name (`TANK Windows · 3 小時前`).
      Read from the DOM rather than a screenshot: the tab reported
      `visibilityState: hidden`, and a screenshot of a hidden tab can show a stale frame.
