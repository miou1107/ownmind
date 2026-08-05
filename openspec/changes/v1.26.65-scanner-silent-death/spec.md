# v1.26.65 — Spec

## Requirement 1 — Registering the scheduled task cannot leave the machine with none

`scripts/windows/register-scanner-task.ps1` contains no `Unregister-ScheduledTask`.
It registers with `-Force`, which replaces a task of the same name in a single
operation, and every parameter it passes is a real `Register-ScheduledTask` parameter.

### Scenario: replacing an existing task

- **GIVEN** a machine that already has the `OwnMind Usage Scanner` task
- **WHEN** the script runs
- **THEN** the task is replaced in one call
- **AND** at no point during the script does the machine have no task

### Scenario: the registration itself fails

- **GIVEN** a PowerShell build that rejects one of the arguments
- **WHEN** `Register-ScheduledTask` throws
- **THEN** the machine still has whatever task it had before, because nothing was
  removed first
- **AND** this is the difference between v1.17.66 costing two users their collector
  permanently and costing them nothing

### Scenario: an invented parameter name

- **GIVEN** a future edit that passes a parameter `Register-ScheduledTask` does not
  have
- **THEN** `tests/scanner-task-durability.test.js` fails in CI rather than on a user's
  machine, the same guard the file already applies to `New-ScheduledTaskSettingsSet`

## Requirement 2 — Registration is confirmed, not assumed

After registering, the script queries the task back and exits non-zero if it is
absent.

### Scenario: registration reports success but produces nothing

- **GIVEN** `Register-ScheduledTask` returning without error
- **WHEN** `Get-ScheduledTask` cannot find the task afterwards
- **THEN** the script writes an error naming the consequence and exits 1

## Requirement 3 — Task Scheduler's recorded result reflects what happened

`scripts/windows/run-hidden.vbs` calls `Run` with `bWaitOnReturn` true and exits with
the launched process's code.

### Scenario: node is missing from the recorded path

- **GIVEN** a task action whose node path no longer exists
- **WHEN** the task fires
- **THEN** `LastTaskResult` is non-zero
- **AND** before this change it was 0, so the standard diagnostic reported a dead
  scanner as healthy

### Scenario: a scan that works

- **GIVEN** a normal run
- **THEN** `LastTaskResult` is 0, and the task shows as running for the duration of
  the scan, bounded by the existing 10-minute `ExecutionTimeLimit`

## Requirement 4 — A failed re-registration fails the upgrade

`scripts/interactive-upgrade.ps1` calls `Fail "reschedule"` when the task script exits
non-zero. `Fail` reports to the server through `Report-Error` and throws.

No rollback: the upgraded files are correct; only the schedule is not.

### Scenario: upgrade succeeds, scheduling does not

- **GIVEN** an upgrade whose file steps all pass and whose task registration fails
- **THEN** the upgrade reports failure naming the scanner
- **AND** a record reaches the server, so it is visible to an admin and not only on
  the user's screen
- **AND** the phrase "upgrade itself complete" appears nowhere in that branch

## Requirement 5 — A scanner that cannot start says so through its exit code

`hooks/ownmind-usage-scanner.js` throws when `readCredentials` yields no key or URL.
The direct-run handler logs `[scanner] fatal: …` and exits 1.

The scanner cannot inherit an environment the way the MCP can, so this branch is
exactly where the two diverge, and the last place a broken scanner can still speak.

### Scenario: settings.json is missing or has lost the ownmind entry

- **GIVEN** a machine where `~/.claude/settings.json` no longer yields credentials
- **WHEN** the scanner runs
- **THEN** the process exits non-zero
- **AND** the reason is still written to `~/.ownmind/logs/scanner.log`
- **AND** with Requirement 3, Task Scheduler shows a failure rather than a success

## Requirement 6 — An unreadable source directory is not reported as an empty one

`defaultListJsonlFiles` is exported. It returns `[]` when `readdir` fails with
`ENOENT`, and rethrows every other error. A single unreadable project directory is
still skipped, because one bad directory must not lose the rest.

### Scenario: a machine that has never run Claude Code

- **GIVEN** no `~/.claude/projects` directory
- **THEN** the result is empty and nothing is thrown; this member genuinely has no
  data

### Scenario: the directory exists but cannot be read

- **GIVEN** a projects directory the process lacks permission to list
- **THEN** the error propagates
- **AND** the scanner's per-adapter handler logs `[scanner] <tool> failed: …`, which
  is visible, instead of `sent=0`, which is not

## Requirement 7 — The scan log distinguishes "nothing new" from "saw nothing"

`readSince` reports `scanned`, the number of source files visible. `runScan` passes it
through as `files`, and the scanner appends `files=N` to its log line. An adapter that
does not report it omits the field rather than printing a wrong number.

### Scenario: files exist but hold nothing new

- **GIVEN** two session files already read to the end
- **THEN** the line reads `sent=0 … files=2`

### Scenario: no files are visible at all

- **GIVEN** a base directory with no session files
- **THEN** the line reads `sent=0 … files=0`
- **AND** these two cases were previously identical text, which is what made a
  correct `sent=0` indistinguishable from a broken one

## Requirement 8 — A file or line that cannot be read costs only that file or line

`createClaudeCodeAdapter` and `createCodexAdapter` guard `readIncremental` per file. A
throw is recorded as its error code in `skipped` and the loop continues. `runScan`
passes `skipped` through, and the scanner appends `skipped=N(CODE)` to its log line.

The heartbeat is built after the file loop in both adapters, so before this an
unreadable file cost the tool its check-in as well as its data. That is the shape a
member with no `codex` row at all has on production.

### Scenario: a session archived mid-scan

- **GIVEN** a Codex session listed under `~/.codex/sessions` and moved to
  `~/.codex/archived_sessions` before it is opened
- **WHEN** the adapter reads it and gets `ENOENT`
- **THEN** the other sessions are still read
- **AND** the heartbeat is still returned, so the member does not silently lose the row
  that proves the tool is installed
- **AND** `skipped` carries `ENOENT`

### Scenario: a file the process cannot open

- **GIVEN** three files where the middle one throws `EACCES`
- **THEN** the two readable files still produce events, and `skipped` is `['EACCES']`

### Scenario: everything readable

- **GIVEN** a run where every file opens
- **THEN** `skipped` is empty and the log line carries no `skipped=` field

### Scenario: one unusable token_count line

- **GIVEN** a Codex session file whose second line carries a non-numeric
  `total_token_usage.total_tokens`
- **WHEN** the adapter reads it and `canonicalizeCodexMaterial` throws
- **THEN** the first and third lines still produce events
- **AND** the heartbeat is still returned
- **AND** `skipped` carries `BADLINE`
- **AND** the file's byte offset still advances past it, so the same line is not retried
  on every future run

### Scenario: a throw that is not an Error

- **GIVEN** a `readIncremental` that throws a bare string
- **THEN** `skipped` records `UNKNOWN` and the warning names the string rather than
  printing the word `undefined` where the reason belongs
