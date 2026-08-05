# v1.26.71 — Spec

## Requirement 1 — One implementation of the fallback, used by every sqlite adapter

### Scenario: the shared module is the only place the CLI is invoked

- **GIVEN** any adapter that reads a SQLite database through the `sqlite3` CLI
- **THEN** it runs its query through `shared/scanners/sqlite-cli.js` and does not
  assemble its own `execFile` arguments

Two copies of this pattern existed and only one was fixed. The second copy is the defect
this change closes, so the structural answer belongs in the change rather than a note
saying to remember next time.

### Scenario: a caller may raise the output ceiling

- **GIVEN** an adapter whose result set is unbounded
- **WHEN** it passes `maxBuffer`
- **THEN** that value is used instead of the default

Tier 2 reads three rows. A Tier 1 first scan reads every assistant message ever written.
The same ceiling cannot be right for both, and the smaller one silently truncates.

### Scenario: the default ceiling is unchanged for callers that do not ask

- **THEN** the default remains 10 MB

## Requirement 2 — OpenCode reads a database its application has closed

### Scenario: the ordinary case

- **GIVEN** OpenCode is running and `-readonly` opens the database
- **THEN** it is read directly and no copy is made

### Scenario: OpenCode is closed

- **GIVEN** `sqlite3 -readonly` fails with `unable to open database file`
- **WHEN** the adapter reads
- **THEN** the rows are returned from a snapshot and events are emitted as normal

Before this change the adapter caught that failure, logged it, and returned
`{ events: [] }` together with a heartbeat. The scan reported success and sent nothing.

### Scenario: a missing sqlite3 CLI still says so

- **GIVEN** the CLI cannot be executed (ENOENT)
- **THEN** no snapshot is attempted and the adapter prints its own install instructions

The message names OpenCode and the per-platform command. Routing ENOENT through the
fallback would replace a one-command fix with a generic failure.

### Scenario: the adapter can report why the snapshot failed

- **THEN** the adapter passes its logger to the shared runner

The fallback's own diagnostics are the only signal distinguishing "the database is
locked" from "the temporary directory is full". Without a logger they are discarded.

## Requirement 3 — The collector says why OpenCode is quiet

### Scenario: the database is there and will not open

- **GIVEN** the read fails and a file exists at `dbPath`
- **THEN** the adapter returns `reason: 'unreadable'`

### Scenario: there is no database at all

- **GIVEN** the read fails and nothing exists at `dbPath`
- **THEN** the adapter returns `reason: 'no_install'`

`sqlite3` says "unable to open database file" for both, which is the same trap v1.26.69
found in the Cursor adapter: "you do not run this tool" reported as "your tool is
broken".

### Scenario: the sqlite3 CLI is missing

- **THEN** the adapter returns `reason: 'sqlite_missing'`

### Scenario: a healthy scan carries no reason

- **THEN** the adapter returns none and the orchestrator derives `ok` or
  `no_new_activity` from whether anything came back

One place decides that, for every adapter.

**Why this is in a change about reading a closed database.** Without it the orchestrator
derives the reason from what the adapter returned — no events, no sessions, no file
count, no skipped list — and answers `no_new_activity`. A database that cannot be read
was being reported as "he did not use OpenCode today", which is indistinguishable from
health and is exactly the signal v1.26.69 exists to prevent. It was also why this
release's own fix could not be observed working on a real machine.

## Requirement 4 — A short read costs a delay, not data

### Scenario: a snapshot that yields a prefix of the history

- **GIVEN** a read that returns a prefix of the rows the cursor asked for
- **THEN** the cursor advances only as far as the rows actually converted into events,
  and the remainder is read on the next scan

`(time_created, id)` ascending, advanced per row. This is the same guarantee the ordinary
incremental path relies on; the snapshot path inherits it rather than needing its own.

### Scenario: the one shape that is not a prefix

- **GIVEN** two messages sharing a `time_created` to the millisecond, committed
  separately, whose ids sort in the opposite order to their commit order
- **AND** a read that sees the second and not the first
- **THEN** the first is behind the cursor on the next scan and is never collected

Named rather than fixed, because the fix is a change to Tier 1 ingestion semantics and
this is not that release. What is known:

- The precondition is unreached in the data. Zero same-millisecond pairs across 1205
  messages on the measured machine. Assistant messages are LLM replies, seconds apart.
- The id is `msg_` plus a time-derived prefix plus a random suffix. Across different
  milliseconds the prefix orders correctly; **within one millisecond the suffix decides,
  so the order really is arbitrary.** The mechanism is real; only its trigger is absent.
- This change does not create it. A scan reading the live database between two commits
  in the same millisecond does the same thing, and has been able to since the adapter was
  written. The snapshot is if anything a narrower window, since the fallback only runs
  when nothing had the database open.

Recorded in `openspec/BACKLOG.md`.

## Requirement 4 — v1.26.70's spec describes what shipped

### Scenario: the copy is opened

- **THEN** the spec says the copy is opened with no flags, and the journal sidecars are
  copied with it

`immutable=1` and `pathToFileURL` were the second design. Measuring that these databases
are in WAL mode with a live `-wal` beside them retired it before release: `immutable=1`
ignores the WAL, which is exactly the newest activity a scan is looking for. `tasks.md`
recorded that and `spec.md` did not, so the normative document described code that does
not exist.
