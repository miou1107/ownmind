# v1.26.130 — Proposal: the repair asked a weaker question than the check

## What is broken

Production, 2026-08-10. Two users, both on 1.26.125, both reported daily by the self-check:

```
scheduler failed | Task Scheduler entry points at another installation,
                   not C:\Users\Adam\.ownmind
```

`self-check.cjs` finds this because v1.26.124 taught it to compare the task's actions against
this installation's directory — `taskBelongsToInstall()` in `scheduler-task-owner.cjs`. But
the self-check only reports.

The thing that repairs is `ensure-scanner-schedule.ps1`, run from `update.ps1` on every
auto-update. Its gate was:

```powershell
if ($task -and $task.State -ne 'Disabled') { "already_registered"; exit 0 }
```

Their task exists and is enabled. It drives a different directory. So the repair declared both
machines healthy and returned — every day, on a machine where the check on the same machine
was saying the opposite.

**Visible and unfixable.** Upgrading does not help them; the repair runs and does nothing.
Nothing else on the machine ever looks at this. Meanwhile their usage columns render blank on
the team page, which reads as "these two did not work".

## Why the gate was weaker

`Get-ScheduledTask` is machine-global. A task with that name existing says somebody installed
OwnMind on this machine at some point, not that *this* installation registered it. That is the
exact trap v1.26.124 documented and extracted a pure function for — and only the reporting
side was updated.

## Approach

One dot-sourceable file, `schedule-health.ps1`, holding what "healthy" means on Windows. Both
the gate before the repair and the verification after it go through it.

Three ways a registered task is not a working schedule, all measured on real machines:

- **Disabled** — exists, never fires; for the user identical to no task (v1.26.79)
- **Owned by another installation** — this release
- **State unreadable** — treated as unhealthy, because `self-check.cjs` treats a missing state
  as "not found". A repair that is more generous than the check puts the two back into
  disagreement, which is the shape of this whole defect

The re-registration itself needs no change: `register-scanner-task.ps1` calls
`Register-ScheduledTask -Force`, which replaces the same-named task in one step. Adam's and
Eric's machines are fixed by being allowed through the gate.

## Why the rule is PowerShell and not a call into node

The Windows side already treats node as something that has to be *found* —
`register-scanner-task.ps1` has a three-strategy resolver and a `.node-path` cache because
`Get-Command node` is not reliable there. Making the health check depend on node would add
that failure mode to a path that currently has none, and the fallback when node is missing
would be the presence-only gate this release exists to remove.

The cost is a second copy of the ownership rule, in a second language. That is paid for by a
test that runs both copies over one case table.

## Testing

The rule is pure string logic with no Task Scheduler cmdlets, so the decision can be
**executed** off Windows: `tests/scanner-schedule-ownership.test.js` runs the PowerShell
functions and the JS ones against the same table, including the exact action string measured
on the machine that produced the false pass.

Text-level assertions — the level the rest of the PowerShell in this repo is pinned at — would
not have caught this. The old gate reads perfectly well. It asks the wrong question.

Both copies are asserted against a stated expectation rather than against each other. Two
implementations that agree on the wrong answer would pass a pure parity check.

## What this does not do

It does not touch the Unix side. `ensure-scanner-schedule.sh` installs a plist / unit under
`$HOME` at a fixed path, so a second installation cannot leave a stranger's schedule behind
the way a machine-global task name can. There is no measured failure there, and no evidence
to build a repair on.

It does not clear the existing self-check alerts. Those go away when the affected machines
next auto-update and the repair finally runs.
