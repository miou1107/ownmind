# Spec — the schedule repair reaches every platform that has a schedule

## Requirement 1 — Windows is repaired by the daily auto-update

### Scenario: `ensure-scanner-schedule.sh` on Windows

- **GIVEN** `OWNMIND_OS` reports a Windows shell environment (`msys`, `cygwin`, `mingw`,
  `win32`)
- **THEN** the script MUST delegate to `ensure-scanner-schedule.ps1`
- **AND** MUST NOT print `OK:schedule:skipped_unsupported_os`

That line is what let a dead schedule pass as `[ OK ] Usage scanner ready`, on the one platform
where the failure this script exists for was actually observed.

### Scenario: the helper's verdict

- **WHEN** the helper answers with a contract line
- **THEN** that line MUST be printed unchanged
- **AND** the helper's exit code MUST be the script's exit code

`update.sh` branches on the exit code. A repair that could not happen must not exit 0, or the
update prints success over it — the same defect one layer up.

### Scenario: an answer that cannot be read

- **GIVEN** the helper crashes, or prints something with no contract line in it
- **THEN** the script MUST exit non-zero
- **AND** MUST include what the helper actually said

Failing closed here is the point. An unparseable answer is not evidence of health, and the
helper's own words are the only thing that makes the failure actionable.

### Scenario: the helper is absent

- **THEN** the script MUST fail, naming the path it looked for

## Requirement 2 — platforms with no schedule are still left alone

### Scenario: any other OS

- **GIVEN** an `OWNMIND_OS` that is not darwin, linux or Windows
- **THEN** the script MUST print `OK:schedule:skipped_unsupported_os` and exit 0

Unchanged. There is nothing to repair, and a non-zero exit would break the caller for no
reason.

## Requirement 3 — the branch is testable without an outage

### Scenario: a test drives the delegation

- **GIVEN** `OWNMIND_PWSH` names an interpreter
- **THEN** the script MUST use it instead of searching PATH

The alternative is deleting a real scheduled task to watch it come back, which is not a test.

## Out of scope

The PowerShell helper's own repair logic, which is covered by
`tests/windows-scanner-schedule.test.js`. This release connects the road; it does not repave
the destination.
