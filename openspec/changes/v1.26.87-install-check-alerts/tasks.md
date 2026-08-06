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

- [ ] `db/021_install_check_alert_state.sql`: one row per `(user_id, machine, check_name)`,
      unique on that triple, with `first_seen_at`, `announced_at`, `resolved_at`, `detail`.
- [ ] Apply on production before deploy (iron rule: run every unapplied migration first).

## Phase 2 — The evaluator (pure, tested first)

- [ ] `src/lib/install-check-alerts.js` — `evaluateFailures({ latestChecks, knownState })`
      returns `{ newFailures, resolved }`. No database access, no clock, no I/O.
- [ ] Tests written before the implementation, using real production payloads as fixtures:
      Adam's `memory_load` failure, a beacon row with no `checks`, an all-green report.
- [ ] Test: **run the same input twice, the second run yields no new failures.** Repeated
      application is the whole point of the state table and the first run passing proves
      nothing about the second.
- [ ] Test: a beacon row does not resolve a live failure.
- [ ] Test: pass-then-fail re-announces.

## Phase 3 — Rollup and rendering

- [ ] `renderAlertMessage(newFailures)` → `{ title, body }`. Groups by
      `(check_name, detail)`; one entry per group naming every affected person and machine.
- [ ] Test: six machines with one shared detail render as one entry.
- [ ] Test: same check with two different details renders as two entries.
- [ ] Test: body over 2000 characters truncates **and states the number omitted**; assert on
      the stated count, not merely on the length.

## Phase 4 — Wiring

- [ ] Insert-then-evaluate in `POST /api/debug/install-check`, after commit, wrapped so a
      throw is logged and swallowed.
- [ ] Startup sweep in `src/index.js`, same evaluator, guarded by the state table.
- [ ] Broadcast creation reuses `broadcast_messages` with the fields the spec fixes;
      `super_admin` attribution copied from `nightly-upgrade-reminder`, not reinvented.
- [ ] Test: evaluator throwing still returns 200 and still stores the row.

## Phase 5 — The check that the checks work

- [ ] **Break it on purpose**: remove the "already announced" guard and confirm the
      run-twice test goes red. A guard nobody has seen fail is a guard nobody has verified.
- [ ] **Break it on purpose**: make the truncation cut silently and confirm the truncation
      test goes red.
- [ ] Positive control on real data: run the evaluator against a copy of production's 393
      rows and confirm it finds the known WSL failures. Zero findings without a positive
      control is not a result.

## Phase 6 — Housekeeping

- [ ] Strip the two NUL bytes from `src/routes/debug.js`; assert in a test that the file
      contains no control bytes, so it cannot silently return.
- [ ] README / FILELIST / CHANGELOG in the same commit.
- [ ] Close backlog item 27 with what shipped and what did not (the admin page is still
      open); do not mark it done on the strength of "the data is uploaded".

## Phase 7 — Quality gates (not optional)

- [ ] `superpowers:verification-before-completion` — full suite green, output pasted, no
      claim of "done" before it is.
- [ ] `superpowers:requesting-code-review` before commit.
- [ ] `superpowers:receiving-code-review` on the feedback.
- [ ] Ask Vin before tagging or deploying. A previous release is not standing authorisation.
