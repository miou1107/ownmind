# v1.26.87 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Measure (done during brainstorming)

- [x] Counted what is actually in the table on production: 393 reports, 9 users, 13
      machines, 2026-05-08 → 2026-08-06. Failures present today, unread.
- [x] Confirmed nothing reads it: `grep install_check_logs src/ client/ mcp/ hooks/` returns
      the migration only.
- [x] Read a real failing payload rather than assuming its shape. Checks are
      `{name, status, detail, fix?, evidence?}`; Adam's `memory_load` failure carries both a
      human explanation and `bash_is_wsl: true`.
- [x] Found `src/routes/debug.js` is `file`-typed `data` — two NUL bytes at lines 73 and 81
      hide it from `grep`, which is why the first search for the route found nothing.

## Phase 1 — Storage

- [x] `db/021_install_check_alert_state.sql`: one row per `(user_id, machine, check_name)`,
      unique on that triple, with `first_seen_at`, `announced_at`, `resolved_at`, `detail`.
- [x] Apply on production before deploy (iron rule: run every unapplied migration first).
      (Applies automatically at deploy time via the existing "run every unapplied migration"
      step; not applied ahead of time during development.)

## Phase 2 — The evaluator (pure, tested first)

- [x] `src/lib/install-check-alerts.js` — `evaluateFailures({ latestChecks, knownState })`
      returns `{ newFailures, resolved }`. No database access, no clock, no I/O.
- [x] Tests written before the implementation, using real production payloads as fixtures:
      Adam's `memory_load` failure, a beacon row with no `checks`, an all-green report.
- [x] Test: **run the same input twice, the second run yields no new failures.** Repeated
      application is the whole point of the state table and the first run passing proves
      nothing about the second.
- [x] Test: a beacon row does not resolve a live failure.
- [x] Test: pass-then-fail re-announces.

## Phase 3 — Rollup and rendering

- [x] `renderAlertMessage(newFailures)` → `{ title, body }`. Groups by
      `(check_name, detail)`; one entry per group naming every affected person and machine.
- [x] Test: six machines with one shared detail render as one entry.
- [x] Test: same check with two different details renders as two entries.
- [x] Test: body over 2000 characters truncates **and states the number omitted**; assert on
      the stated count, not merely on the length.

## Phase 4 — Wiring

- [x] Insert-then-evaluate in `POST /api/debug/install-check`, after commit, wrapped so a
      throw is logged and swallowed.
- [x] Startup sweep in `src/index.js`, same evaluator, guarded by the state table.
- [x] Broadcast creation reuses `broadcast_messages` with the fields the spec fixes;
      `super_admin` attribution copied from `nightly-upgrade-reminder`, not reinvented.
- [x] Test: evaluator throwing still returns 200 and still stores the row.

## Phase 5 — The check that the checks work

- [x] **Break it on purpose**: remove the "already announced" guard and confirm the
      run-twice test goes red. A guard nobody has seen fail is a guard nobody has verified.
- [x] **Break it on purpose**: make the truncation cut silently and confirm the truncation
      test goes red.
- [x] Positive control on real data: run the evaluator against a copy of production's 393
      rows and confirm it finds the known WSL failures. Zero findings without a positive
      control is not a result.

Task 7 ran the finished code against the 12 real machine reports from production. Exact
output:

```
檢測出現 1 個新問題

memory_load 失敗 — Adam（after）、Vin-windows-test（TANK）
  memories have never loaded automatically on this account (`bash` on this machine is the WSL launcher, whose home directory is not this one)
  修法：Re-run the installer, then fully restart your AI tool and open a new conversation
  版本 1.26.84、1.26.86
```

12 machines read, 2 new failures found (Adam, Vin-windows-test), rolled up to 1 entry
(same `check_name` + `detail`), `omitted: 0`, body 301 characters — well inside the 2000
limit. Task 7 also broke each guard on purpose (removed the "already announced" check,
made the truncation cut silent) and confirmed the covering test went red both times, then
restored and confirmed green.

## Phase 6 — Housekeeping

- [x] Strip the two NUL bytes from `src/routes/debug.js`; assert in a test that the file
      contains no control bytes, so it cannot silently return.
- [x] README / FILELIST / CHANGELOG in the same commit.
- [x] Update backlog item 27 with what shipped and what did not (the admin page is still
      open, deliberately deferred); do not mark it done on the strength of "the data is
      uploaded" — the item stays open, not closed.

## Phase 7 — Quality gates (not optional)

- [x] `superpowers:verification-before-completion` — full suite green, output pasted, no
      claim of "done" before it is.
- [x] `superpowers:requesting-code-review` before commit. One Important finding (13-vs-12
      machine count in the CHANGELOG was unreconciled); fixed by tracing the actual SQL
      filter and adding a grounded one-clause explanation, not a guess.
- [x] `superpowers:receiving-code-review` on the feedback.
- [ ] Ask Vin before tagging or deploying. A previous release is not standing authorisation.
