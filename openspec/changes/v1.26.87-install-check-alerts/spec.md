# v1.26.87 — Spec

## ADDED Requirement: a failure is identified by machine and check, not by report

A failure SHALL be keyed by `(user_id, machine, check_name)`. Every decision about whether
to announce something is made against that key.

`install_check_alert_state` holds one row per key, with `first_seen_at`, `announced_at` and
`resolved_at`.

### Scenario: the same red light in ten consecutive reports

- **GIVEN** `(Adam, LAPTOP-MBGGLV2J, memory_load)` has been announced
- **WHEN** nine further reports arrive, each still failing that check
- **THEN** no further broadcast is created

The upgrade flow uploads several reports per run — `install_started`, `post_install`,
`upgrade_complete`. Announcing per report would produce three copies of one problem.

### Scenario: fixed, then broken again

- **GIVEN** an announced failure whose key later appears with `status: 'pass'`
- **WHEN** that report is evaluated
- **THEN** `resolved_at` is set and no broadcast is created
- **AND** if the same key fails again afterwards, it is announced again

Silence about recovery is deliberate; re-arming is not. A regression is news.

### Scenario: the same check fails for a different stated reason

- **GIVEN** an announced failure whose key later reports a different `detail`
- **THEN** no new broadcast is created, and the stored `detail` is updated

The key is deliberately the check, not its wording. Self-check messages get rewritten
between releases; re-announcing on every rewording would make every upgrade look like a new
outbreak.

### Scenario: a failure that predates this release

- **GIVEN** `install_check_logs` holds reports that were never evaluated
- **WHEN** the evaluator runs for the first time
- **THEN** every currently-failing key is treated as new and announced once

The two-month-old WSL failures are the reason this release exists; they must surface rather
than be grandfathered into silence.

## ADDED Requirement: only the latest report per machine decides current state

For each `(user_id, machine)`, the evaluator SHALL read the most recent report **that
carries a `checks` array** and treat it as the current state of that machine.

### Scenario: beacon rows do not clear a failure

- **GIVEN** the newest row for a machine is an `install_started` beacon with no `checks`
- **AND** the row before it reported `scheduler: fail`
- **THEN** `scheduler` is still considered failing

Beacons are emitted before the checks run. Letting one count as "no failures present" would
mark every problem resolved at the start of the next upgrade.

## ADDED Requirement: only `fail` is announced

Checks with `status: 'warn'` SHALL NOT produce a broadcast and SHALL NOT be written to the
state table.

### Scenario: a warn-only report

- **GIVEN** a report whose checks are 9 `pass` and 1 `warn`
- **THEN** no broadcast is created

## ADDED Requirement: identical failures across machines are one line

New failures SHALL be grouped by `(check_name, detail)`. One group renders as one entry
listing every affected person and machine.

### Scenario: six machines, one WSL bash

- **GIVEN** six machines newly failing `memory_load` with the same `detail`
- **THEN** the message contains one entry for `memory_load`, naming all six machines
- **AND** not six entries

Vin's words in the backlog: 「6 machines, same WSL bash」 must read as one row, not six.

### Scenario: same check, different cause

- **GIVEN** two machines failing `scheduler` with different `detail` strings
- **THEN** they render as two entries

## ADDED Requirement: the message is enough to act on without opening anything

Each entry SHALL carry the check name, the affected people and machines, the `detail`
string, the `fix` string when the report supplies one, and the client version.

### Scenario: the entry for Adam's machine

- **GIVEN** the failing check
  `{name: 'memory_load', status: 'fail', detail: 'memories have never loaded…', fix: 'Re-run the installer…'}`
  reported by Adam on `LAPTOP-MBGGLV2J` at `1.26.84`
- **THEN** the rendered entry contains `memory_load`, `Adam`, `LAPTOP-MBGGLV2J`, the detail
  text, the fix text and `1.26.84`

## ADDED Requirement: truncation is stated, never silent

Broadcast bodies are capped at 2000 characters. When the rendered entries do not fit, the
message SHALL include the count of entries omitted.

### Scenario: more failures than fit

- **GIVEN** rendered entries exceeding the cap
- **THEN** the body ends with a line stating how many entries were left out
- **AND** the body is at most 2000 characters

A cut that does not announce itself reads as "that was everything", which is the defect this
release exists to remove.

## ADDED Requirement: the broadcast reaches Vin and only Vin

The broadcast SHALL be created with `type='announcement'`, `severity='warning'`,
`is_auto=TRUE`, `allow_snooze=FALSE`, `target_users=[<oldest super_admin id>]` and
`ends_at = now + 7 days`.

`severity='warning'` is load-bearing: `hooks/lib/render-session-context.js` injects the
action-required block for warnings, so the AI raises it in its first reply rather than
rendering it passively.

### Scenario: no super_admin exists

- **GIVEN** the users table has no `super_admin`
- **THEN** evaluation records state as usual but creates no broadcast, and logs the reason

Matches `nightly-upgrade-reminder`'s existing behaviour rather than inventing a second rule.

## ADDED Requirement: alerting never costs a report

Evaluation SHALL run after the `install_check_logs` insert has committed, and any error it
raises SHALL be caught and logged.

### Scenario: the evaluator throws

- **GIVEN** `POST /api/debug/install-check` with a valid body
- **AND** evaluation raises
- **THEN** the response is still `200`
- **AND** the row is present in `install_check_logs`

### Scenario: startup sweep failure does not stop the server

- **GIVEN** the startup sweep raises
- **THEN** the server still serves requests

## ADDED Requirement: `src/routes/debug.js` is plain text

The file SHALL contain no bytes in `\x00-\x08` or `\x0e-\x1f`.

### Scenario: the file is searchable

- **WHEN** `grep -c install-check src/routes/debug.js` runs
- **THEN** it reports a non-zero count

Two raw NUL bytes at lines 73 and 81 make `file` report the source as `data` and make `grep`
skip it as binary, so a search of `src/` for the route's own path comes back empty.
