# Spec — v1.26.149 command-classifier parity (issue #92)

## Requirement 1 — the two classifiers answer identically

Both `detectCommandTrigger()` (`shared/helpers.js`) and the `grep` chain in
`hooks/ownmind-iron-rule-check.sh` classify a command into `commit`, `deploy`, `delete`,
`install`, or nothing. For any command, the two must return the same answer.

### Scenario: a release tag reaches the commit trigger on every platform

- **GIVEN** the PreToolUse hook receives `git tag v1.2.3`
- **WHEN** either implementation classifies it
- **THEN** both answer `commit`
- **AND** the version-sync rules the user filed under `trigger:commit` are listed

Before this change the shell copy answered nothing, so on mac and Linux the hook was silent
during the one operation those rules were written for.

### Scenario: a docker compose build is a deploy

- **GIVEN** the command is `docker compose build` or `docker compose push web`
- **WHEN** either implementation classifies it
- **THEN** both answer `deploy`

The shell deploy pattern was `docker.*deploy|docker.*up`, matching neither.

### Scenario: reading a container log is not a deploy

- **GIVEN** the command is `docker logs backup` or `docker ps | grep uptime`
- **WHEN** either implementation classifies it
- **THEN** both answer nothing
- **AND** no deployment rules are printed

`up` appears inside `backup` and `uptime`, and `docker.*up` matched both.

### Scenario: a PowerShell delete is a delete

- **GIVEN** the command is `Remove-Item -Recurse ./dist`
- **WHEN** either implementation classifies it
- **THEN** both answer `delete`

### Scenario: a swarm deploy is a deploy

- **GIVEN** the command is `docker stack deploy -c stack.yml web`
- **WHEN** either implementation classifies it
- **THEN** both answer `deploy`

Only the shell copy recognised this. Squaring the two promoted the pattern into the
reference rather than removing it.

### Scenario: a command in two families follows the reference's order

- **GIVEN** the command is `docker compose up -d && rm -rf ./old`
- **WHEN** either implementation classifies it
- **THEN** both answer `deploy`

Both families match. The reference tests deploy before delete; the shell chain tested delete
first and disagreed. This is the one row where the answer is a decision rather than a fix.

### Scenario: a dependency install stays silent

- **GIVEN** the command is `npm install`
- **WHEN** either implementation classifies it
- **THEN** both answer nothing

A reminder in front of every dependency install is one the user learns to scroll past.
Pinned here because the parity test is now the place a widened `install` pattern would be
noticed.

## Requirement 2 — the guard observes the real implementation

### Scenario: the shell side is measured by running the hook

- **GIVEN** the parity test classifies a command through the shell copy
- **WHEN** it determines what that copy answered
- **THEN** it spawns `hooks/ownmind-iron-rule-check.sh` and reads the trigger out of the
  banner the hook prints
- **AND** it never restates the hook's `grep` patterns in the test file

A test that re-transcribes the logic is a third copy, and it agrees with whichever copy its
author was reading.

### Scenario: an unreadable banner fails rather than reading as "no trigger"

- **GIVEN** the hook prints output the test cannot parse — a renamed banner, for instance
- **WHEN** the test tries to extract the trigger
- **THEN** it throws with the output it received

Returning `null` there would silently reclassify every command as "no trigger detected" and
the whole file would pass while measuring nothing.

### Scenario: the guard does not skip itself away

- **GIVEN** the test run is on a machine where `bash` may or may not resolve
- **WHEN** the shell half of the parity test runs
- **THEN** it spawns `bash` unconditionally, as
  `tests/iron-rule-install-trigger.test.js` already does

A `bash is missing` skip turns the half of the file that guards the drifting copy into a
green no-op, which is indistinguishable from having no guard.

## Requirement 3 — the duplication is documented where it is duplicated

### Scenario: both sides name the other and name the guard

- **GIVEN** a developer reads either copy
- **WHEN** they reach the classification logic
- **THEN** a `KEEP IN SYNC` note names the other copy, states that the order matters as
  well as the patterns, and names `tests/iron-rule-trigger-parity.test.js`

The pre-existing note covered `TRIGGER_TAG_ALIASES` only, which is why the classification
below it drifted for as long as it did.

## Out of scope

- Removing the duplication (issue #92 options A and B) — needs a decision on whether the
  shell copy's independence from node still holds.
- The banner strings, which are English in one copy and Chinese in the other — issue #91.
