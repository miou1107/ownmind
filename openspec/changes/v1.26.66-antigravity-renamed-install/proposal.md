# v1.26.66 — Antigravity renamed its storage directory and the collector kept reading the old one

The `antigravity` adapter hardcodes one storage directory. The application now ships
under a second name and writes to a second directory. On a machine where both exist,
the adapter reads the abandoned one, finds a date frozen months in the past, correctly
concludes there is nothing new to record, and sends a healthy heartbeat. Nothing in the
pipeline reports an error at any point.

## Measured on Vin's Mac, 2026-08-05

Two applications are installed:

| Bundle | Version | Storage directory |
|---|---|---|
| `com.google.antigravity` | 2.5.0 | `~/Library/Application Support/Antigravity` |
| `com.google.antigravity-ide` | 2.1.1 | `~/Library/Application Support/Antigravity IDE` |

Their telemetry, read directly with `sqlite3`:

| Directory | `firstSessionDate` | `currentSessionDate` | Workspaces | File mtime |
|---|---|---|---|---|
| `Antigravity` | 2025-12-10 | **2026-05-18** | 22 | 2026-05-20 |
| `Antigravity IDE` | **2026-05-20** | 2026-08-05 | 1 | 2026-08-04 |

One directory stops on the day the other starts. That is a migration, not two products
used in parallel, and the adapter is pointed at the side that was abandoned.

Running the shipped adapter unchanged against each path in turn:

```
Antigravity      -> [{"date":"2026-05-18"}]
Antigravity IDE  -> [{"date":"2026-08-05"}]
```

Same code, same machine, same moment. The only difference is the directory name.

## What this cost

`session_count` on production for `tool='antigravity'`, user 1: nine rows ending
2026-05-18, plus a single unexplained row on 2026-07-23 that no directory on this
machine can account for and which this change does not try to explain. Two other users'
rows end 2026-05-18 and 2026-05-19. Those two machines were not inspected, so the
matching dates are a correlation, not a measurement.

Roughly eleven weeks of one tool's usage was never recorded, on a machine that was
checking in every two hours the entire time.

## Why it stayed invisible

The adapter is Tier 2: `events` is always `[]` by construction, so a broken Antigravity
adapter cannot show up as missing token data. Its only output is one `session_count`
row per new day. "No new day" is the normal, expected result of most scans, and it is
also exactly what a permanently frozen directory produces. The two are indistinguishable
from the server, from the scanner log, and from the heartbeat.

This is the same shape as the seven defects in v1.26.65: a failure whose signature is
identical to routine success.

## Not in scope

**Joanna's case, which prompted this.** Her `session_count` runs to 2026-08-03 on
win32, so her installation writes to the directory the adapter already reads. Her
silence since then is leave, 08-03 to 08-09. Nothing on her machine is broken.

**The Tier 2 ceiling.** Antigravity exposes no token counts, so an Antigravity user can
never appear in token usage reporting no matter how much they use it. That is a product
limitation to state clearly somewhere, not a defect to fix here.

**The 2026-07-23 row.** Unexplained, and left unexplained rather than given a plausible
cause that cannot be traced to the command that produced it.

## The fix

Resolve the database across every known install directory instead of one hardcoded
name, and read the freshest. A directory that is not present is skipped without a
query, so a single-install machine behaves exactly as it does today and produces no new
log noise.

Cursor shares `createVscodeAdapter` and has one known directory. It passes a
single-element list and its behaviour is unchanged.
