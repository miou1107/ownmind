# v1.26.130 — Spec

## Requirement: the repair and the check ask the same question

The Windows schedule repair MUST treat a scheduled task that drives another installation as
broken, exactly as `self-check.cjs` reports it.

### Scenario: the task belongs to another installation

- **GIVEN** a task named `OwnMind Usage Scanner` exists, is enabled, and its actions name
  `C:\Users\Vin\.ownmind`
- **AND** this installation is `C:\Users\Adam\.ownmind`
- **WHEN** the repair runs during an auto-update
- **THEN** it does not report `already_registered`, and re-registers the task

### Scenario: the task belongs here

- **GIVEN** the task's actions name this installation's directory
- **AND** its state is `Ready` or `Running`
- **WHEN** the repair runs
- **THEN** the task is left completely untouched

### Scenario: the task is disabled

- **GIVEN** the task belongs to this installation but its state is `Disabled`
- **WHEN** the repair runs
- **THEN** it is treated as broken — a task that never fires is, for the user, no task at all

### Scenario: the state cannot be read

- **GIVEN** `Get-ScheduledTask` returns a task with no readable state
- **WHEN** the repair runs
- **THEN** it is treated as broken, because `self-check.cjs` treats the same input as
  "not found"; a repair more generous than the check puts the two back into disagreement

### Scenario: the actions cannot be read

- **GIVEN** the current user may not read the task's action list
- **WHEN** the repair runs
- **THEN** ownership is treated as unknown and the task is not re-registered on that basis —
  a permissions quirk must not trigger a repair

## Requirement: one definition of "this installation"

The repair, the registration and the self-check MUST resolve the installation directory the
same way, so that a repair always converges.

### Scenario: the repair resolves it differently from the registration

- **GIVEN** the repair compares against a path the registration never writes
- **WHEN** a task is re-registered
- **THEN** the post-repair check rejects it again, and every subsequent auto-update repeats
  the whole cycle and reports a failure — so the suite fails on the divergence instead

### Scenario: an install-path override is set

- **GIVEN** `$env:OWNMIND_DIR` pointed somewhere other than the Windows profile
- **WHEN** the daily update runs
- **THEN** the repair ignores it, because that variable is set at install time and is not in
  the environment the update runs in; a value only one of the three sides can see cannot be
  the value they agree on

## Requirement: the evidence the gate decides on is itself testable

### Scenario: the action reader is emptied

- **GIVEN** `Get-TaskActionText` is changed to return `''`
- **WHEN** the suite runs on a machine with PowerShell
- **THEN** it fails — otherwise every ownership check falls to "cannot tell", the gate
  silently returns to its pre-v1.26.130 behaviour, and nothing goes red

### Scenario: a task carries more than one action

- **GIVEN** a task with two actions
- **WHEN** its action text is read
- **THEN** both appear, because the one naming the installation may not be the first

## Requirement: a failed repair says what it saw

### Scenario: the task still points elsewhere after re-registering

- **GIVEN** re-registration did not replace the foreign task
- **WHEN** the failure is reported
- **THEN** it names the directory expected and the command the task actually runs — the
  omission of exactly this is why the defect survived from v1.26.79

## Requirement: the ownership rule has one home per language

The rule MUST NOT be restated inline in `ensure-scanner-schedule.ps1`.

### Scenario: the gate is changed back to presence and state

- **GIVEN** the health gate is rewritten as `$task -and $task.State -ne 'Disabled'`
- **WHEN** the suite runs
- **THEN** it fails, naming the gate

### Scenario: the two language copies disagree

- **GIVEN** either `taskBelongsToInstall()` or `Test-TaskBelongsToInstall` is changed
- **WHEN** the suite runs on a machine with PowerShell
- **THEN** it fails — both are run against one case table, and both are asserted against a
  stated expectation rather than against each other

## Requirement: a repair reports only what it verified

### Scenario: re-registration leaves a task owned elsewhere

- **GIVEN** the repair re-registers the task
- **AND** the task still does not name this installation
- **WHEN** the repair finishes
- **THEN** it reports a failure to the server rather than `OK:schedule:repaired`
