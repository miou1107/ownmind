# Repair, on the road the failure travels

## Why

`scripts/install-helpers/ensure-scanner-schedule.sh` opens by explaining itself:

> Measured on production 2026-08-06: Adam's collector last reported on 2026-07-15. His MCP was
> alive the whole time, auto-updating and heartbeating daily. Only the scheduled task was gone.
> Three weeks, nobody noticed, because nothing was watching.
>
> The Windows side already had a repair (`interactive-upgrade.ps1` re-registers the task, and
> its comment names Adam). It never reached him: only `bootstrap.ps1` calls it, and nobody runs
> bootstrap by hand. **Repair has to live on the road the failure travels, which is the daily
> auto-update.**

The daily auto-update on Windows is `bash update.sh`. That is the exact command the server
hands out in `upgrade_action.command`, and Git Bash runs it. It called this script, which
matched `darwin*`, then `linux*`, then fell through to the default branch and printed:

```
OK:schedule:skipped_unsupported_os
```

`update.sh` accepted the zero exit and moved on, having already printed `[ OK ] Usage scanner
ready`. Measured on Windows 2026-08-15, running the upgrade command OwnMind itself supplies.

So the fix for the incident was never connected to the platform the incident happened on. The
Windows repair still exists, in `ensure-scanner-schedule.ps1`, and is still only reached by the
thing nobody runs by hand.

## What changes

**A Windows branch that delegates to the PowerShell helper.** Same output contract —
`OK:schedule:already_registered` / `OK:schedule:repaired` / `ERROR:schedule:<why>` — so
`update.sh` reads the real verdict and its existing failure path (warn, and report to the
server) starts working on Windows for the first time.

**An unreadable answer is an error, not an OK.** If the helper crashes or prints something this
script cannot parse, it fails and quotes what the helper said. "I could not tell" and "it is
fine" are different facts, and only one of them is safe to print above a line that says
`ready`.

**`OWNMIND_PWSH`** lets a test drive the branch with a stub. Deleting a developer's own
scheduled task to watch it come back is not a test.

**The default branch keeps its meaning** for platforms that genuinely have no schedule, and its
comment no longer claims Windows is one of them.

## Impact

- `scripts/install-helpers/ensure-scanner-schedule.sh` — one new branch.
- `tests/scanner-schedule-windows-delegation.test.js` — new; five of its six cases fail against
  the previous commit.
- No change on macOS or Linux.
