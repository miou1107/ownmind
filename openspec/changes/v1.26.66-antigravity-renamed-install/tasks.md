# v1.26.66 — Tasks

Legend: `[ ]` pending · `[x]` done

Two shared scanner modules and one test file. No server change, no schema change, no
migration, no console change, no Windows script change.

## Phase 0 — Measure before designing (done)

- [x] Ran the shipped adapter unchanged against both directories on Vin's Mac and got
      2026-05-18 and 2026-08-05 from the same code
- [x] Read the raw telemetry out of both databases with `sqlite3` directly, rather than
      inferring it from adapter output
- [x] Confirmed the two bundle identifiers and versions, so "renamed" is a measurement
      and not an assumption
- [x] Confirmed from `session_count` on production that user 1's antigravity rows end
      2026-05-18, matching the frozen directory
- [x] Established that Joanna is **not** affected: her rows run to 2026-08-03 on win32,
      so this change is not the fix for the case that surfaced it
- [x] Left the unexplained 2026-07-23 row unexplained instead of inventing a cause

## Phase 1 — RED (done)

- [x] `tests/scanner-vscode-multipath.test.js`
- [x] Renamed install: two candidates, fresher one second, expect the fresher date
- [x] Ordering does not decide: same two candidates, order reversed, same result
- [x] Per-candidate fallback: `lastSessionDate` on one, older `currentSessionDate` on
      the other, expect the fallback date to win
- [x] Empty candidate does not suppress a usable one
- [x] Absent candidate is never queried, and logs nothing
- [x] A candidate that exists and fails to read still warns, and the others are read
- [x] `antigravityDbCandidates` covers darwin, win32, linux and the unknown-platform
      fallback
- [x] Explicit `dbPath` still reads exactly one path
- [x] Watched 11 fail on real assertions, not on a module link error; the two
      backwards-compatibility guards passed before and after, which is what they are for
- [x] Made every layout assertion accept both path separators. `path.join` uses the
      host's separator, not the described platform's, so a forward-slash-only assertion
      passes on a Mac and silently asserts nothing on Windows — the same trap a
      v1.26.65 review caught in a chmod-based test

## Phase 2 — GREEN (done)

- [x] `shared/scanners/vscode-telemetry.js`: accept `dbPaths`, filter by existence,
      read each surviving candidate, pick the latest date
- [x] `shared/scanners/antigravity.js`: export `antigravityDbCandidates`, pass both
      names per platform
- [x] `shared/scanners/cursor.js`: unchanged
- [x] New tests pass and `tests/scanner-cursor-antigravity.test.js` stays green

## Phase 3 — Verify (done)

- [x] Full suite: 2744 tests, 0 failures, 2 skipped (the known v1.26.65 chmod guards)
- [x] Ran the real adapter with defaults against the real machine: candidates resolve to
      both directories and the emitted date is 2026-08-05, where before the change the
      same call produced 2026-05-18
- [x] Re-scan with the returned state emits nothing, so the cursor still works
- [x] Confirmed the production call site is `spec.factory({ scannerVersion, machine })`
      with no `dbPath`, so the candidate list is what actually runs. A fix that only
      works when a test passes a path would have been inert in production and neither
      the unit tests nor the reviewer would have seen it.

## Phase 3b — End-to-end positive control (done)

Running the adapter proves the adapter. It does not prove the scanner, the POST, or
that anything landed. Verified separately on 2026-08-05:

- [x] Baseline: `session_count` for user 1 / antigravity held 9 rows, newest 2026-07-23,
      no 2026-08-05
- [x] Ran the real scanner with `OWNMIND_SKIP_TOOLS` limiting it to antigravity
- [x] After: 10 rows, newest **2026-08-05**, and the local cursor advanced to the same
      date
- [x] Surfaced a further defect that only an end-to-end run could show, below

## Phase 3c — The log line a human reads (done)

The row landed and the scanner wrote `antigravity sent=0 accepted=0 duplicated=0
batches=0` about it. `sent` counts token events; Tier 2 has none by construction. So
cursor and antigravity printed all zeros whether they had just recorded a day or
recorded nothing, and two of the five tools could not be diagnosed from that line at
all. It is how a dead adapter went eleven weeks unnoticed.

- [x] RED first. The production edit was written before the test, reverted, and redone
      after watching the guard fail.
- [x] `hooks/ownmind-usage-scanner.js` prints `sessions=N`; `runScan` already returned it
- [x] Re-ran the real scanner and read the line back: `... batches=0 sessions=0`
- [x] Scope widened by one line beyond the change Vin asked for, and said so rather than
      folded in quietly

## Phase 4 — Sync (done)

- [x] `package.json` 1.26.66
- [x] `README.md`, `docs/README.ja.md`, `docs/README.zh-TW.md` version line
- [x] `CHANGELOG.md`
- [x] `FILELIST.md` for the new test file

## Phase 5 — Review (done)

Two rounds against a non-git copy outside the repo.

**Round 1 — three findings, two fixed, one rejected.**

- [x] *Fixed.* `defaultExists` caught every error and returned false, so a permission
      wall read as "not installed" and the candidate was dropped before sqlite ran,
      taking the warning with it. That is v1.26.65's defect reintroduced through a new
      door, and it violated this change's own Requirement 3. Now only `ENOENT` is
      absent.
- [x] *Fixed.* Taking the maximum date blindly let one abandoned database with a
      rolled-forward clock win forever: emitted once, cursor advanced to it, every real
      date afterwards suppressed as "not new". One dead directory would have become a
      dead tool. Dates more than 24h ahead are now discarded with a warning.
- [x] *Rejected.* "Only emit when the date advances." The server upserts with
      `GREATEST(existing, incoming)` on `(user_id, tool, date)`, checked in
      `src/routes/usage/events.js`, so a re-emit costs one redundant write of a real
      day. Requiring the date to advance would mean any cursor that ever got ahead of
      reality silently suppresses every real day beneath it, permanently. Recorded as
      Requirement 6 so this is not "fixed" later by someone reading only the code.

**Round 2 — no findings.** A clean round is not evidence on its own, so the call sites
were checked independently rather than taken on trust; that check is the last item in
Phase 3.

## Phase 6 — Out of scope, recorded rather than done

- [ ] Antigravity's Tier 2 ceiling is invisible to anyone reading a usage report: a
      heavy Antigravity user shows zero tokens and looks idle. Belongs in the console,
      not here.
- [ ] Whether the other two users whose rows end 2026-05-18/19 are affected. Their
      machines were not inspected; matching dates are not a measurement.
- [ ] The fix only reaches a user when their client upgrades. Nothing here backfills the
      eleven weeks already missed, and the telemetry keys hold only the latest session,
      so that data is not recoverable.
