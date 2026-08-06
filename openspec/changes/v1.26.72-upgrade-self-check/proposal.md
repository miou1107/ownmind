# v1.26.72 — After an upgrade, the machine asks the server whether its data arrived

## Why

Every collector defect found in the last week had the same shape: the machine believed
it was working, the server had nothing, and no layer said so. v1.26.66 was eleven weeks
of that. v1.26.69 gave a silent collector a reason. v1.26.70 and v1.26.71 fixed two
databases that could not be opened. All three were found by a person reading a log file
on the machine itself.

That is the actual gap. **The evidence needed to diagnose a collector only exists on the
machine that has the problem**, and nobody looks at it there. Amiee's `codex` has never
checked in since 2026-05-05 and the investigation is still blocked on physical access to
her laptop (backlog 17).

## What this adds

One question, asked at the one moment somebody is present and paying attention: the end
of an install or upgrade.

1. Run a scan.
2. Ask the server what it now holds **for this account, from this machine**.
3. Print a verdict a non-engineer can act on.

Step 2 is the part that makes it worth doing. The scanner already sees an `accepted=`
count come back from each batch it posts, and that has never been enough: it says a
request succeeded, not that the server ended up holding the data, and it says nothing at
all on the runs with nothing to send — which is every run on a machine that is broken.
Reading it back independently is a different claim.

## The verdicts

Per tool, from what this machine just scanned and what the server reports:

| | meaning | level |
|---|---|---|
| `confirmed` | the server has this tool, from this machine, just now | ok |
| `not_installed` | this machine does not have the tool | ok |
| `other_machine` | the server's row for this tool names a different computer | warn |
| `not_recorded` | this machine scanned and the server has nothing recent from it | fail |
| `blocked` | this machine could not read the tool's data | fail |

`other_machine` is the visible face of backlog 14: `collector_heartbeat` is unique per
`(user_id, tool)`, so a person with two computers has them overwriting each other.
**This change does not fix that and does not wait for it.** It surfaces it, which is
strictly better than today, where the second machine is simply absent with no trace.

## Scope

Read-only on the server, no schema change. One new endpoint returning **only the calling
account's own rows**, one client entry point, and a call at the end of both installers.

The environment and debug snapshot Vin also asked for is deliberately not here. It needs
`collector_heartbeat` to be per-machine first, or every machine's diagnostics overwrite
the last one's and the collected data is worse than none. Backlog 14, then that.
