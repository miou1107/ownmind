# v1.26.130 — Tasks

- [x] Confirm the gap on the two reported machines: `self-check.cjs` compares the task's
      actions against `OWNMIND_DIR`; `ensure-scanner-schedule.ps1` checks only presence and
      `Disabled`
- [x] Confirm re-registering is what fixes it — `register-scanner-task.ps1` uses
      `Register-ScheduledTask -Force`, so there is no delete-then-create window
- [x] `tests/scanner-schedule-ownership.test.js` — red first, against the shipped gate
- [x] `scripts/install-helpers/schedule-health.ps1` — `Test-ScheduleHealthy` /
      `Test-TaskBelongsToInstall`, pure string logic so the decision is executable off Windows
- [x] `ensure-scanner-schedule.ps1` — dot-source it; gate and post-repair verification both
      go through it
- [x] `npm test` green; version, CHANGELOG and FILELIST updated
- [x] The PowerShell assertions run in CI, not on this machine — macOS has no PowerShell, and
      the amd64 container is emulated and produced corrupted results (a qemu translate.c
      assertion failure). Run 31367550646: all four legs green, the assertions executed rather
      than skipped
- [x] Mutation check on CI, not just locally: `Test-TaskBelongsToInstall` forced to `$true`
      went red on all four legs, naming "Adam's task is not healthy — this is the whole
      defect". Throwaway branch, deleted after
- [x] Code review — one Critical and two Important fixed:
      - the repair honoured `$env:OWNMIND_DIR` while the registration and the self-check never
        have, so a custom install path produced a repair that could never converge: reject,
        re-register the profile path, reject again, report a failure every day forever. All
        three now compute one value, and the override is gone from the repair — it is absent
        from the environment when the daily update runs, so it could never have been the
        shared value
      - `Get-TaskActionText` carried all the new evidence and was the one piece of new
        PowerShell the suite could not execute. Returning `''` from it would have collapsed
        the gate to the old behaviour with every test still green. Moved into
        `schedule-health.ps1` and driven with fake task objects
      - the post-repair failure omitted what the task actually points at — the same omission
        that let this defect live since v1.26.79. It now carries the action text, the expected
        directory, and what to do about a task owned by another Windows account
- [x] Minor: `self-check.cjs` queried without `-TaskPath '\'` (the repair always pinned it);
      the post-repair check could be negated without a test going red; `codeOnly()` did not
      strip block comments, which the slice boundaries depend on
- [ ] Ship — Vin's call
