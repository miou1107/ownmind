# v1.26.70 — Spec

## Requirement 1 — A database that will not open read-only is read from a copy

### Scenario: the ordinary case is untouched

- **GIVEN** a database `sqlite3 -readonly` can open
- **THEN** it is read directly, no copy is made, and the file system is not touched

The fallback must cost nothing on the runs that do not need it, and must not be the
thing that breaks the runs that were working.

### Scenario: the editor is closed

- **GIVEN** `sqlite3 -readonly` fails with `unable to open database file`
- **WHEN** the collector retries
- **THEN** the database is copied to a temporary directory **with its journal sidecars**,
  the copy is opened **with no flags at all**, and the same rows are returned

### Scenario: both halves are required

- **THEN** the live file is only ever opened read-only, and the copy is never opened
  read-only

Neither half works alone, which was measured rather than assumed. A plain copy retried
with `-readonly` fails exactly like the original: what `-readonly` wants is the `-shm`
sidecar, and the copy has no sidecar either. The first implementation of this change did
exactly that and the real-CLI test caught it.

An unflagged open is what makes the copy readable. SQLite owns the snapshot, so it may
create the sidecars it needs and replay the WAL, and everything it writes goes away with
the temporary directory. The live file must never be opened that way, because it belongs
to another application.

### Scenario: the journal sidecars come along

- **THEN** `-wal`, `-shm` and `-journal` are copied beside the snapshot when they exist,
  and their absence is not an error

These databases are in WAL mode and a running editor really does leave a `-wal`. Copying
only the main file drops whatever has not been checkpointed, which is exactly the most
recent activity a scan is looking for. Absent is the ordinary case, since a clean
shutdown checkpoints and removes them; a crash does not, and that is the case worth
carrying them for.

**This replaces `file://…?immutable=1`, which was the second of three designs.** It fixed
the sidecar problem and then measurement retired it: `immutable=1` ignores the WAL by
design, so it has the same flaw from the other direction. `pathToFileURL` went with it.

### Scenario: the copy is removed

- **THEN** the temporary copy is deleted whether the retry succeeded or failed

A collector that leaks a copy of a multi-megabyte database on every scan is worse than
the silence it was written to fix.

### Scenario: the copy is never written beside the original

- **THEN** the temporary file lives under the system temporary directory

The collector reads other applications' data. It does not write into their directories.

## Requirement 2 — Only that one failure is retried

### Scenario: the sqlite3 CLI is missing

- **GIVEN** the CLI cannot be executed at all (ENOENT)
- **THEN** the error is raised unchanged and no copy is attempted

v1.26.69 relies on this error to report `sqlite_missing`, which on Windows is a
one-command fix. A retry that turned it into something else would take that back.

### Scenario: some other sqlite failure

- **GIVEN** a failure that is not `unable to open database file`
- **THEN** it is raised unchanged

### Scenario: the database does not exist at all

- **GIVEN** a path with no file at it
- **THEN** the copy fails and **the original error is raised**, not the copy's

The caller classifies the original: v1.26.69's adapter asks `exists` and turns it into
`no_install`. Replacing the error with one from the fallback would change a machine that
does not have the tool into a machine whose tool is broken.

## Requirement 3 — A copy is a snapshot, not a promise

### Scenario: the copy is unreadable too

- **GIVEN** the copy also fails to open
- **THEN** the original error is raised and the collector reports `unreadable`

The fallback only runs when the editor appears to be closed, so a torn copy is unlikely.
It is not impossible: nothing stops the application from starting mid-copy. The failure
mode is a read that errors, and an errored read is already handled.

This is why the unflagged open is only ever applied to the snapshot. Opening the live
file that way would let another application's in-progress writes through as data, and
would put this collector's writes into a file it does not own — a worse outcome than the
missing days this change fixes.
