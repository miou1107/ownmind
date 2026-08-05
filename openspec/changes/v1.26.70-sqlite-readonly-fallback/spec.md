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
- **THEN** the database is copied to a temporary directory, the copy is opened as
  `file://…?immutable=1`, and the same rows are returned

### Scenario: both halves are required

- **THEN** the live file is never opened immutable, and the copy is never opened
  read-only

Neither half works alone, which was measured rather than assumed. A plain copy fails
exactly like the original: what `-readonly` wants is the `-shm` sidecar, and the copy has
no sidecar either. The first implementation of this change did exactly that and the
real-CLI test caught it. `immutable=1` against the live file is worse than the bug, since
it promises SQLite that a file an editor is actively writing cannot change.

Copying is what makes the promise true. The snapshot is private, nothing else can write
to it, and `immutable=1` becomes a statement of fact.

### Scenario: the copy is addressed as a URI

- **THEN** the path is converted with `pathToFileURL`

A Windows drive letter, a backslash, or a directory with a space in it all have to
survive being put inside a `file:` URI.

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

This is why `immutable=1` is only ever applied to the snapshot. On the live file the same
flag would let torn pages through as data, silently, which is a worse outcome than the
missing days this change fixes.
