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
- [ ] The PowerShell assertions run in CI, not on this machine — macOS has no PowerShell, and
      the amd64 container is emulated and produced corrupted results (a qemu translate.c
      assertion failure). Verified on the CI runners before merge
- [ ] Code review
- [ ] Ship — Vin's call
