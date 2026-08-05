# v1.26.69 — Tasks

Legend: `[ ]` pending · `[x]` done

Both halves of this change came out of one question a colleague asked on 2026-08-05:
"did the test account receive any Antigravity data?" Answering it took an hour of manual
work, and the point of the change is that the answer was already known to the collector.

## Phase 0 — Measure before designing

- [x] Found that half of this was already built: v1.26.50's `observedUsers` separates
      `flowing` / `silent` / `not_installed` / `offline`, and `silent` is exactly the
      hazard state. The gap is that `silent` has no reason, not that the state is
      missing. That made the change smaller and better targeted.
- [x] Confirmed `collector_heartbeat.status` is dead: hardcoded `'active'` in both
      halves of the upsert, never selected by `loadClients`
- [x] Found the name collision that decided the schema. `loadClients` already computes a
      per-client `status` of `active` / `stale` / `offline` / `unknown` from heartbeat
      age. Reusing the database column called `status` for a reason would put two
      meanings under one name across two layers, so the reason gets its own column.
- [x] Confirmed the heartbeat upsert is rate-limited to 30 seconds, which would have
      swallowed a *change* of reason as readily as a repeated timestamp
- [x] Confirmed the collector already computes most of the answer and discards it:
      `scanned` / `skipped` (v1.26.65), the sqlite3-missing warning, and
      `defaultExists`'s ENOENT distinction (v1.26.66)
- [x] Confirmed `scanner-offsets.json` carries no account identity, so the account-switch
      hazard is real regardless of whether it is what happened on the machine that
      prompted it

## Phase 1 — RED

- [x] `tests/collector-silence-reason.test.js`
- [x] Ran against stubs: **16 failed, 4 passed**
- [x] Audited the four passes. Two were vacuous against a stub that returns nothing:
      "every code fits the column" iterated an empty set, and "is stable across calls"
      compared `''` with `''`. Both now assert non-emptiness first.
- [x] Re-ran: **18 failed, 2 passed**, the two being regression guards for behaviour
      this change must not alter

## Phase 2 — GREEN

- [x] `shared/scanners/reasons.js` — the closed set
- [x] `readVscodeTelemetry` returns `{ failure }` instead of a bare `{}`, so
      "could not read" stops being indistinguishable from "read fine, nothing in it"
- [x] `readFreshestSessionDate` returns `{ date, failures, looked }`. `looked` is the
      part that separates "nothing installed here" from "installed and idle"; without
      it both are the same empty answer.
- [x] `createVscodeAdapter` derives the Tier 2 reason
- [x] `deriveReason` in `base.js` covers Tier 1 from the `scanned` / `skipped` those
      adapters already report, so codex and opencode are diagnosable without touching
      three more adapters
- [x] `accountFingerprint` / `cursorForAccount`
- [x] `runScan` threads the reason onto the heartbeat and returns it
- [x] `hooks/ownmind-usage-scanner.js` checks the account once per run, not per adapter
- [x] `db/018_collector_heartbeat_reason.sql`
- [x] `src/routes/usage/events.js` validates against the closed set at the boundary and
      adds `OR reason IS DISTINCT FROM EXCLUDED.reason` to the rate limit
- [x] `src/routes/usage/admin-clients.js` selects and returns it
- [x] `client/src/pages/System/observed-users.js` attaches it (Server + Client both)

## Phase 3 — A design correction found by writing the test

The first implementation discarded the whole cursor on an account change. Writing the
test made the flaw obvious: `byte_offset` and `last_session_date` claim different things.

- [x] `last_session_date` is a claim that a day was already reported. That day belongs to
      whoever worked it, so it is dropped.
- [x] `byte_offset` is a position marker meaning "read this far". Keeping it *is* the
      no-backfill policy. Dropping it would have replayed the machine's entire history
      into the new account, which is the misattribution the policy exists to prevent.
- [x] A cursor with no fingerprint is stamped, not reset, so upgrading does not wipe
      every existing install

## Phase 4 — Verify

- [x] Full suite: 2803 tests, 0 failures, 2 skipped (the known v1.26.65 chmod guards)
- [x] Ran the real scanner on a real machine. It printed reasons immediately:

```
[scanner] cursor      ... sessions=0 reason=unreadable
[scanner] antigravity ... sessions=1 reason=ok
```

- [x] **The `unreadable` was true and new**, and my first reading of it was wrong.
      `sqlite3 -readonly` fails on Cursor's `state.vscdb` with SQLITE_CANTOPEN while
      `file:...?immutable=1` succeeds. From that plus a `currentSessionDate` of
      2026-06-02 I concluded Cursor usage had been missing since June, and told Vin so.
      He then opened Cursor: the date and the file mtime both became current and the
      scanner reported `cursor sessions=1 reason=ok`. June 2 was the last day he had
      used it, nothing more. A zero read as a finding with no positive control, which is
      the thing iron rule 770 exists to stop; his opening the app *was* the control.
- [x] Isolated the real trigger with a controlled test instead: a copy of the database
      in an empty directory fails `-readonly` and reads fine as `immutable=1`, while the
      live file succeeds under `-readonly` whenever Cursor is running and a
      `state.vscdb-shm` sidecar exists. Tier 2 can therefore only read the database
      while the editor happens to be open. Corrected in backlog item 20.

## Phase 5 — Sync

- [x] `package.json` 1.26.69
- [x] `README.md`, `docs/README.ja.md`, `docs/README.zh-TW.md`
- [x] `CHANGELOG.md`
- [x] `FILELIST.md`
- [x] `openspec/BACKLOG.md` — item 20

## Phase 6 — Review

Two passes: my own against the same questions, then an adversarial one against a non-git
copy outside the repo. Between them, six defects, all fixed. Every one was in code
written tonight.

**Found by my own pass, before the reviewer ran.**

- [x] A single-`dbPath` adapter reported `unreadable` for a tool that is simply not
      installed. Cursor names one database and queries it unfiltered by design, so the
      CLI's "unable to open database file" arrived as a failure rather than an absence.
      That is precisely the confusion this change exists to remove. The empty branch now
      asks `exists` before settling on `unreadable`.
- [x] The account fingerprint hashed the raw `apiUrl`, while `postBatch` strips trailing
      slashes before posting. Two configs differing by one `/` would have read as an
      account change and dropped every day cursor on the machine.
- [x] The heartbeat upsert would have written on every single beat. The MCP and the
      scanner share one row per `(user_id, tool)` and only the scanner sends a reason,
      so `reason IS DISTINCT FROM EXCLUDED.reason` would have been true forever and the
      30-second rate limit would have stopped working for the busiest tool.

**Found by the reviewer.**

- [x] **My fix for the third one broke my own spec.** `COALESCE(EXCLUDED.reason, …)`
      treats "no reason field" and "a reason this server does not recognise" as the same
      thing. They are opposites: the first is an old collector that cannot say, the
      second is a newer collector reporting a change. Under COALESCE a collector that
      started failing with an unknown code would have kept displaying its last healthy
      `ok`. Now a `reasonProvided` flag separates them, and the spec's "unknown is
      rejected, not stored" scenario is actually honoured.
- [x] `cursorForAccount` dropped a whole entry because of one field. No entry carries
      both a day claim and a read position today, so nothing was broken, but the day the
      first one does, the read position would vanish with it and replay the machine's
      history into the new account. It now removes the field, not the entry.
- [x] The `looked` counter ignored an extra source that answered "nothing yet", so an
      installed Antigravity CLI with an empty conversation store reported `no_install` —
      telling an operator to install what is installed. `probeConversations` now returns
      `{ date, looked }` so "no directory" and "empty directory" stop being the same
      answer.

**Accepted as a limitation, not fixed.**

- [x] *"The SQL tests are regex greps and cannot fail."* Correct, and the fix was
      available: the events router already takes an injected `query`. The four heartbeat
      tests now drive the real route and assert the parameters that actually reach the
      database, which is what caught the `reasonProvided` shape. What is still not
      tested is Postgres semantics — `CASE WHEN`, `IS DISTINCT FROM`, the interval — as
      the suite has no database.

- [x] Full suite: 2810 tests, 0 failures, 2 skipped
- [x] Re-verified on the real machine after the fixes:

```
[scanner] codex       ... files=84 reason=no_new_activity
[scanner] opencode    ...          reason=no_new_activity
[scanner] cursor      ...          reason=unreadable
[scanner] antigravity ... sessions=1 reason=ok
```

## Phase 7 — Out of scope, recorded rather than done

- [ ] Migration 018 is not applied to production. Until it is, the server ignores the
      field; the column is additive and nullable, so an old server and a new collector
      are compatible in both directions.
- [ ] The console renders `reasons` but no page displays them yet; the data reaches the
      client and the presentation is a separate change.
- [ ] `collector_heartbeat.status` is still dead and still written as `'active'`.
      Removing it is a migration with no behaviour attached, better done on its own.
- [ ] Whether the machine that prompted this actually changed account was never
      confirmed from credential history; the three facts that line up are recorded in
      the proposal as the leading explanation, not as proof.
