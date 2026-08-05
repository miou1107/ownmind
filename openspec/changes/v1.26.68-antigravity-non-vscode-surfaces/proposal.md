# v1.26.68 — Antigravity's non-VSCode surfaces are invisible to the collector

## The defect

Antigravity is not one application. It ships as three surfaces that share one account,
one settings tree and one MCP config:

| Surface | Bundle | Local data | VSCode telemetry? |
|---|---|---|---|
| Agent manager (`Antigravity.app` 2.5.0) | `com.google.antigravity` | `~/.gemini/antigravity/` | frozen since 2026-05-18 |
| Editor (`Antigravity IDE.app` 2.1.1) | `com.google.antigravity-ide` | `~/.gemini/antigravity-ide/` | yes, current |
| CLI (`agy`) | — | `~/.gemini/antigravity-cli/` | none, ever |

The collector reads exactly one signal for this tool: `telemetry.currentSessionDate`
inside a VSCode `state.vscdb`. Only the editor writes one. v1.26.66 fixed *which*
`state.vscdb` the collector reads, which made the editor visible. It did not change the
fact that two of the three surfaces are not VSCode applications and never write that
file at all.

## Measured on Vin's Mac, 2026-08-05

Conversation stores, counted by file mtime, metadata only:

| Surface | Conversation files | Distinct days | Days after 2026-05-20 |
|---|---|---|---|
| manager | 114 | 10 | 8 |
| editor | 108 | 6 | 4 |
| CLI | 1489 | 9 | 9 |

Union across the three: **17 distinct days, 2026-03-24 through 2026-08-05.**

The manager's own `state.vscdb` still reports `currentSessionDate = 2026-05-18`. Eight
days of manager conversations and nine days of CLI conversations happened after that
date and none of them are recoverable from any signal the collector reads today.

The 22:35 conversation Vin ran in the manager to test this is
`~/.gemini/antigravity/conversations/df8d3160-….db`, mtime `2026-08-05 22:37`.

## This corrects an earlier conclusion

Backlog item 18 recorded that using the manager wrote **no** session or conversation
data locally, and reasoned from that towards cloud-only storage. That measurement looked
under `~/Library/Application Support/Antigravity`, where the Electron shell lives. The
conversation store is under `~/.gemini/`. It was written, in the right ten-minute window,
in a directory that was never checked.

The general failure: "I searched where this kind of application usually puts things, and
found nothing" was recorded as "the application writes nothing".

## The fix

Give the `antigravity` adapter a second date source: the newest file mtime under
`~/.gemini/<surface>/conversations/` for the three known surfaces. The freshest of all
sources wins, exactly as v1.26.66 made the freshest of several `state.vscdb` files win.

Three properties that are not incidental:

1. **Metadata only.** Conversation files hold conversation content. The reader calls
   `stat()` and never opens one. This is enforced by a source guard in the tests, not by
   good intentions.
2. **A named list of surfaces, not a glob.** `~/.gemini/antigravity-backup/` exists on
   this machine, holds 101 conversation files, and is a dead copy left by the 2026-05-20
   migration. `antigravity*` would match it. The same reasoning as v1.26.66's
   "a stale install must not poison the cursor".
3. **The future-date ceiling covers the new source too.** A file with a rolled-forward
   mtime would otherwise win every comparison forever and silently suppress the live
   surfaces.

## How the conversation store compares with the telemetry it supplements

VSCode's `currentSessionDate` advances when the application is *launched*. A conversation
file's mtime appears to require an actual write: the manager was launched at 12:59 and the
earliest conversation file touched that day is 13:05, and across eight months its store
shows 10 distinct days, far fewer than the days it has been opened.

Two observations are not a proof. SQLite in WAL mode can touch `-wal` and `-shm` on open,
so "launched but unused" being recorded as a day is not ruled out. If it happens it
matches what the existing telemetry already does, and it can only over-report, never
under-report, which is the safe direction for a signal whose whole purpose is to stop
working days from vanishing.

## Out of scope, recorded

`install.sh` still writes no MCP config for Antigravity, so no heartbeat and no
`user_tool_last_seen` ever fire for it. The path is now verified from three independent
places and is recorded in the backlog for a separate change.
