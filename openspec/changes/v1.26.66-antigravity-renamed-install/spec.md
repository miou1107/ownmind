# v1.26.66 — Spec

## Requirement 1 — Antigravity is resolved across every known install directory

`createAntigravityAdapter` no longer targets a single directory name. It builds a
candidate list per platform covering both known names, and the shared VSCode adapter
reads across the list.

### Scenario: the application has been renamed

- **GIVEN** a machine where `Antigravity` holds telemetry ending 2026-05-18
- **AND** `Antigravity IDE` holds telemetry ending 2026-08-05
- **WHEN** the adapter scans
- **THEN** the session it emits carries 2026-08-05

### Scenario: only the original directory exists

- **GIVEN** a machine with `Antigravity` and no `Antigravity IDE`
- **WHEN** the adapter scans
- **THEN** it reads `Antigravity` and behaves exactly as it did before this change

### Scenario: candidates on each platform

- **GIVEN** `antigravityDbCandidates(platform, homeDir)`
- **THEN** darwin yields both names under `Library/Application Support`
- **AND** win32 yields both under `AppData/Roaming`
- **AND** linux yields both under `.config`
- **AND** an unknown platform falls back to the darwin layout, as the previous code did

## Requirement 2 — The freshest install wins

When more than one candidate holds telemetry, the adapter uses the one with the latest
`currentSessionDate`, falling back to `lastSessionDate` per candidate exactly as the
single-path code does.

### Scenario: the older directory is the fresher one

- **GIVEN** two candidates whose dates are 2026-08-05 and 2026-05-18, in that order
- **WHEN** the adapter scans
- **THEN** it emits 2026-08-05
- **AND** ordering within the candidate list does not decide the outcome

### Scenario: one candidate has no telemetry rows at all

- **GIVEN** a candidate whose database exists but returns no telemetry keys
- **AND** a second candidate with a usable date
- **WHEN** the adapter scans
- **THEN** the usable date is emitted
- **AND** the empty candidate does not suppress it

### Scenario: a candidate falls back to lastSessionDate

- **GIVEN** one candidate holding only `lastSessionDate` 2026-08-01
- **AND** one candidate holding `currentSessionDate` 2026-07-01
- **WHEN** the adapter scans
- **THEN** it emits 2026-08-01, because the fallback is applied per candidate before
  comparison, not after

## Requirement 3 — A directory that is not installed is skipped without a query

Candidates are filtered by file existence before any sqlite invocation. **Only `ENOENT`
counts as absent.** Any other failure means the question could not be answered, and the
candidate goes through to the query so the existing warning fires.

### Scenario: the probe cannot answer

- **GIVEN** a candidate behind a permission wall on a parent directory
- **OR** a candidate whose path runs through a regular file
- **WHEN** the adapter resolves candidates
- **THEN** the candidate is treated as present and queried
- **AND** the resulting failure is logged

Answering "absent" here would drop the candidate before sqlite runs and take the
warning with it, which is the defect of v1.26.65 reintroduced through a new door.
A machine that is genuinely broken pays one failed query and one log line per scan.

### Scenario: the second install is absent

- **GIVEN** a machine with one of the two directories
- **WHEN** the adapter scans
- **THEN** sqlite is invoked once, for the directory that exists
- **AND** no warning is logged, because a directory that was never installed is not a
  failure

This is the difference between adding a second candidate and adding a recurring "sqlite
query failed" line to every scan on every single-install machine.

### Scenario: no directory exists at all

- **GIVEN** a machine that has never installed Antigravity
- **WHEN** the adapter scans
- **THEN** no session is emitted
- **AND** the heartbeat is still sent, so the tool is still visibly checking in

### Scenario: a directory exists but cannot be read

- **GIVEN** a candidate that exists and whose sqlite query fails
- **WHEN** the adapter scans
- **THEN** the existing warning is logged for that candidate
- **AND** the other candidates are still read

A file that is present and unreadable is not the same as a file that was never there,
and the two must not collapse into the same silent result.

## Requirement 4 — The injection contract is preserved

### Scenario: an explicit single path

- **GIVEN** a caller passing `dbPath`
- **WHEN** the adapter scans
- **THEN** only that path is read, and existing callers and tests are unaffected

### Scenario: Cursor

- **GIVEN** `createCursorAdapter`
- **WHEN** the adapter scans
- **THEN** it reads its one known directory and its behaviour is byte-for-byte the
  behaviour it had before this change

## Requirement 5 — A stale install cannot poison the live one

A candidate whose session date is more than 24 hours ahead of now is discarded, with a
warning.

### Scenario: an abandoned database holds a future timestamp

- **GIVEN** an abandoned directory whose telemetry reads 400 days ahead
- **AND** a live directory whose telemetry reads two days ago
- **WHEN** the adapter scans
- **THEN** the live date is emitted
- **AND** the discarded date is logged rather than dropped silently

Taking the maximum blindly would let that one row win every comparison forever: emitted
once, cursor advanced to it, every subsequent real date suppressed as "not new". One
dead directory would become a dead tool.

### Scenario: ordinary clock jitter

- **GIVEN** a session date two hours ahead of now
- **WHEN** the adapter scans
- **THEN** it is used normally and nothing is logged

The guard is for absurd values. Rejecting anything at all ahead of now would drop real
sessions across timezone boundaries and ordinary drift.

### Scenario: nothing but a future date

- **GIVEN** the only candidate holds a future date
- **WHEN** the adapter scans
- **THEN** no session is emitted, because a day that has not happened is not a session
- **AND** the heartbeat is still sent

## Requirement 6 — The day cursor stays self-healing

The emit condition remains "the resolved date differs from the stored one", not "the
resolved date is later than the stored one".

### Scenario: the fresher install is transiently unreadable

- **GIVEN** a stored cursor of 2026-08-05 taken from the live install
- **WHEN** that install is momentarily unreadable and the adapter falls back to an older
  install reading 2026-08-01
- **THEN** 2026-08-01 is emitted again and the cursor moves back

This is deliberate. The server upserts `session_count` with
`GREATEST(existing, incoming)` on `(user_id, tool, date)`, so the cost is one redundant
write of a day that genuinely happened.

### Scenario: why not require the date to advance

- **GIVEN** a cursor that has somehow got ahead of reality
- **WHEN** the emit condition requires the date to advance
- **THEN** every real day beneath it is suppressed permanently and silently

A redundant idempotent write is recoverable. Permanent silent suppression is the exact
failure this release and v1.26.65 exist to remove, so the cursor errs toward re-sending.

## Requirement 7 — The scanner log can answer the question for a Tier 2 tool

The per-tool log line carries `sessions=N` alongside `sent=N`.

### Scenario: a Tier 2 tool that just recorded a day

- **GIVEN** the antigravity adapter emitting one session
- **WHEN** the scanner logs the result
- **THEN** the line reads `sent=0 ... sessions=1`

### Scenario: a Tier 2 tool that recorded nothing

- **THEN** the line reads `sent=0 ... sessions=0`

Before this, both cases printed the identical `sent=0 accepted=0 duplicated=0
batches=0`, because `sent` counts token events and Tier 2 has none by construction. Two
of the five tools could not be diagnosed from the one line a human actually reads. The
count was already returned by `runScan`; it simply never reached the log.

## Requirement 8 — A future rename is one line

### Scenario: a third directory name appears

- **GIVEN** a future Antigravity build using a third directory name
- **THEN** adding it means adding one entry to the per-platform name list
- **AND** no change to the shared adapter, the scanner, or the server
