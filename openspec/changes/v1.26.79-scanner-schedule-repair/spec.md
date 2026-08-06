# v1.26.79 — Spec

## ADDED Requirement: the auto-update path repairs a dead scanner schedule

Every auto-update SHALL check that the usage scanner's schedule is registered and able to
run, and SHALL restore it when it is not.

The check runs from `update.sh` (macOS, Linux) and `update.ps1` (Windows), which
`mcp/index.js` invokes after `git pull`. Registration logic is not duplicated: the Windows
helper delegates to `scripts/windows/register-scanner-task.ps1`.

### Scenario: the schedule is alive

- **GIVEN** launchd has `com.ownmind.usage-scanner` loaded (or the systemd timer is both
  active and enabled, or Task Scheduler has `OwnMind Usage Scanner` in a state other than
  `Disabled`)
- **WHEN** the auto-update runs
- **THEN** nothing is registered, loaded, unloaded or rewritten
- **AND** the helper prints `OK:schedule:already_registered` and exits 0

A healthy schedule must be left completely alone. Re-registering it would reset its timer
on every update and re-run the scanner for no reason.

### Scenario: the schedule is gone

- **GIVEN** the OS has no scheduled job for the scanner
- **WHEN** the auto-update runs
- **THEN** the helper registers it, asks the OS again, and exits 0 with
  `OK:schedule:repaired`
- **AND** on macOS the plist is written to `~/Library/LaunchAgents` with `{HOME}`
  substituted for the real home directory

### Scenario: the task exists but is disabled (Windows)

- **GIVEN** `Get-ScheduledTask` returns `OwnMind Usage Scanner` with `State = 'Disabled'`
- **WHEN** the auto-update runs
- **THEN** it is treated as broken and re-registered

A task that is present and never fires produces the same outcome for the user as no task
at all: no data arrives. Checking presence alone would report one of the two ways this can
break as healthy.

### Scenario: the timer runs now but will not survive a reboot (Linux)

- **GIVEN** `systemctl --user is-active` succeeds but `is-enabled` does not
- **WHEN** the auto-update runs
- **THEN** the units are reinstalled and `enable --now` is run

The two commands answer different questions. A timer that satisfies only one of them is
this same defect on a delay.

### Scenario: the repair does not take

- **GIVEN** the registration command runs but the OS still has no usable schedule
- **THEN** the helper prints `ERROR:schedule:<why>`, exits non-zero, and sends a
  `scanner_schedule_repair_failed` report to the server
- **AND** the calling update script prints a warning and **continues**, so the update as a
  whole is not marked failed

The file sync did succeed; failing the whole run would make `mcp/index.js` log
`update_failed` and retry. The failure is not swallowed either — silence is the defect
being fixed, so it has to land somewhere Vin can see rather than in a console window on
someone else's machine.

### Scenario: registration is verified by asking the OS, never by trusting an exit code

- **WHEN** a registration command returns without error
- **THEN** the schedule's existence SHALL still be re-queried before success is reported

This repo has already shipped a release where registration reported success and the
machine had no task on it (v1.17.66, two users affected).

## MODIFIED Requirement: install-time registration is verified on Unix

`install.sh` SHALL confirm with launchd / systemd that the schedule is present after
registering it, and SHALL report to the server when it is not.

### Scenario: launchctl load returns cleanly but launchd has nothing

- **GIVEN** `launchctl load -w` exits 0
- **WHEN** `launchctl list com.ownmind.usage-scanner` fails
- **THEN** install.sh prints the retry command and sends
  `scanner_schedule_install_failed`

Previously the exit code of `launchctl load` was the only thing consulted, and the failure
path printed one `[WARN]` line into an install log nobody re-reads. Windows has verified
its own registration since v1.17.12; the Unix branches never had.
