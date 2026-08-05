# v1.26.71 — The last adapter that could only read while its application was running

## The defect

v1.26.70 fixed `sqlite3 -readonly` for Tier 2 and recorded, out of scope, that
`shared/scanners/opencode.js` carried its own copy of the same pattern. This is that
item. `opencode.js:201` still runs:

```js
execFileP(sqlitePath, ['-json', '-readonly', dbPath, sql], …)
```

with no fallback, and any failure is caught and turned into `{ events: [] }`.

## Measured on Vin's Mac, 2026-08-06

Same controlled test as v1.26.70. Copy the database into an empty directory so no
sidecar sits beside it:

```
$ sqlite3 -json -readonly "<copy>" "SELECT count(*) FROM message;"
Error: in prepare, unable to open database file (14)

$ sqlite3 -json "<copy>" "SELECT count(*) FROM message;"
[{"count(*)":1205}]
```

`PRAGMA journal_mode` on the live file returns `wal`, so this is the same database shape
and the same failure.

**The first measurement of this was contaminated, by the person taking it.** `-readonly`
against the live file appeared to succeed, which read as "OpenCode is not affected". It
succeeded because the `PRAGMA journal_mode` command run one line earlier had opened the
database read-write and created the `opencode.db-shm` sidecar that `-readonly` needs. A
directory listing taken before that probe shows no sidecars at all. The reading tool
created the condition it then reported as pre-existing.

## Why this one is worse than the Tier 2 case

Tier 2 loses a day count that can be inferred from other days. OpenCode is Tier 1: it
emits `token_events`, the per-message record that everything else is derived from. There
is no second source. A user who runs OpenCode and closes it before the scan fires
contributes nothing at all, and the collector reports success.

It is also more likely to be closed than an editor. OpenCode is a terminal application
run per task; Cursor is left open for a day at a time.

## What is not at risk

The cursor is composite `(time_created, id)` and only ever advances to rows actually
read, so a short read costs nothing but a delay: the rest arrives on the next scan. This
is the same property that makes the ordinary incremental path safe, and it is why a torn
snapshot cannot lose data here.

## The fix

Extract v1.26.70's fallback into `shared/scanners/sqlite-cli.js` and have both callers
use it. One implementation, one set of tests, one place to fix the next thing found.

Two differences between the callers are preserved rather than averaged:

- **`maxBuffer`.** Tier 2 reads three telemetry rows and allows 10 MB. A Tier 1 scan
  returns every assistant message since the cursor and allows 100 MB. Lowering OpenCode's
  to match would be a new failure mode on a first scan of a long history.
- **The install hint.** OpenCode names itself in the "sqlite3 CLI not found" message.
  ENOENT must still reach it unchanged, which the shared function already guarantees.

## The second half, found in review

The adapter caught every failure into `{ events: [] }` with a heartbeat and **no
`reason`**. The orchestrator then derives one from what came back — no events, no
sessions, no file count, no skipped list — and answers `no_new_activity`.

So a database that cannot be read has been reporting as *"he did not use OpenCode
today"*. That is the false-healthy signal v1.26.69 was written to remove, still open for
this one adapter, and it is also why the fix above could not have been seen working on a
real machine: there was no channel to say it had started working.

Now `unreadable`, `no_install` or `sqlite_missing`, with the same `exists(dbPath)`
question v1.26.69 added for Cursor — `sqlite3` says "unable to open database file" both
for a closed database and for a path with nothing at it, and reporting the second as the
first turns "you do not run OpenCode" into "your OpenCode is broken".

## Cost

One copy of the database on the runs that need it. Measured on the largest of the four
on this machine: 13 MB, 24 ms. The other three are 3.2 MB, 1.2 MB and 512 KB. No size
guard is added, because at 24 ms there is nothing to guard against.

## Also in this change

v1.26.70's own `spec.md` and `proposal.md` still describe `immutable=1` and
`pathToFileURL`, the design that was measured wrong and replaced before it shipped. The
tasks file records the correction and the spec never got it, so the normative document
for that change describes an implementation that does not exist. Corrected here.
