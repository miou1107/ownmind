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

Try `-readonly` first. On SQLITE_CANTOPEN, copy the database to a temporary directory,
open the copy as `file://…?immutable=1`, and delete it afterwards.

**Both halves are required, and the first implementation got this wrong.** It copied the
file and retried `-readonly` on the copy, which fails identically: what `-readonly` wants
is the `-shm` sidecar and a copy has no sidecar either. The real-CLI test caught it
before it shipped.

`immutable=1` on the live file would be worse than the bug, promising SQLite that a file
an editor is writing cannot change and letting torn pages through as data. Copying is
what makes the promise true: the snapshot is private and nothing else can write to it.

The cost is one file read of a few megabytes on the runs that need it, and nothing at all
on the runs that do not.

## Blast radius

`defaultRunSqlite` is shared by every Tier 2 adapter, so this covers Cursor and
Antigravity, and `opencode` has its own copy of the same pattern which is left alone in
this change and recorded.

Antigravity is already insulated by accident: v1.26.68 gave it the `~/.gemini`
conversation store, so it has a second source when the database will not open. Cursor
has no fallback, which is why it is the one that went quiet.
