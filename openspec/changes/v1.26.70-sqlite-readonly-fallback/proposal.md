# v1.26.70 — Tier 2 must be readable when the editor is closed

## The defect

`defaultRunSqlite` opens every Tier 2 database with `sqlite3 -json -readonly <path>`.
That open fails with SQLITE_CANTOPEN whenever the editor is not running.

Isolated on Vin's Mac, 2026-08-06, with a controlled test. Copy the database into an
empty directory so nothing sits beside it:

```
$ sqlite3 -json -readonly "<copy>" "SELECT key FROM ItemTable LIMIT 1;"
Error: in prepare, unable to open database file (14)

$ sqlite3 -json "file:<copy>?immutable=1" "SELECT key FROM ItemTable LIMIT 1;"
[{"key":"HostColorSchemeData"}]
```

Same bytes, two outcomes. Against the live file the same `-readonly` command succeeds
while Cursor is running, and a `state.vscdb-shm` sidecar is present next to it. Close
Cursor and the sidecar goes away with it.

So Tier 2 collection depends on the editor being open at the moment the scheduled scan
fires. On the 30-minute Mac schedule that is partly luck. On Windows, where the task
repeats every 120 minutes, it is mostly luck. The missed days are absent rather than
wrong, which is why no layer ever flagged it.

## How it was found, and what that cost

v1.26.69 made the collector say `reason=unreadable` instead of nothing, and this turned
up in the first run. The first reading of it was wrong: the database also held
`currentSessionDate = 2026-06-02`, and that got written down as "Cursor usage has been
missing since June". Vin then opened Cursor, both the date and the file mtime became
current, and the collector reported `sessions=1 reason=ok`. June 2 was simply the last
day he had used Cursor.

A zero taken as a finding with no positive control. His opening the app was the control,
and it falsified the claim. The controlled copy test above is what replaced it.

## The fix

Try `-readonly` first. On SQLITE_CANTOPEN, copy the database **and its journal
sidecars** to a temporary directory, open the copy **with no flags**, and delete it
afterwards.

**Two designs were measured wrong on the way to that, and both corrections are the
useful part.**

- The first copied the file and retried `-readonly` on the copy. It fails identically:
  what `-readonly` wants is the `-shm` sidecar and a bare copy has no sidecar either. The
  real-CLI test caught it before it shipped.
- The second opened the copy as `file://…?immutable=1`, which fixes that, and then a
  measurement retired it. These databases are in WAL mode and a running editor really
  does leave a `state.vscdb-wal` beside them. Copying only the main file drops whatever
  has not been checkpointed, which is exactly the most recent activity a scan is looking
  for, and `immutable=1` ignores the WAL by design.

An unflagged open on a private copy has neither problem: SQLite owns the snapshot, so it
may create the sidecars it needs and replay the WAL, and everything it writes is
discarded with the temporary directory. The live file is only ever opened `-readonly`,
and that is what keeps this safe.

The cost is one file read of a few megabytes on the runs that need it, and nothing at all
on the runs that do not.

## Blast radius

`defaultRunSqlite` is shared by every Tier 2 adapter, so this covers Cursor and
Antigravity, and `opencode` has its own copy of the same pattern which is left alone in
this change and recorded. **v1.26.71 closed that second copy** and moved the fallback
into `shared/scanners/sqlite-cli.js` so there is only one of it.

Antigravity is already insulated by accident: v1.26.68 gave it the `~/.gemini`
conversation store, so it has a second source when the database will not open. Cursor
has no fallback, which is why it is the one that went quiet.
