# Spec — v1.26.142

## 1. A thrown adapter still checks in

### Scenario: an adapter throws during its scan

- **GIVEN** the scanner's adapter list contains `codex`
- **AND** `runScan` throws for that adapter (any error, at any point)
- **WHEN** the scanner finishes that iteration
- **THEN** it POSTs a heartbeat for `codex` carrying `reason: "adapter_error"`,
  this machine's hostname and this scanner's version
- **AND** the heartbeat carries an `error` string holding the thrown message
- **AND** the loop continues to the next adapter unchanged

### Scenario: the failure report itself fails

- **GIVEN** an adapter has thrown
- **AND** the POST that reports the failure also throws (offline, 401, 5xx)
- **WHEN** the scanner handles it
- **THEN** it logs the second failure and continues to the next adapter
- **AND** no exception escapes the loop

Rationale: a diagnostic that can end the run is worse than the defect it reports.

### Scenario: an adapter succeeds

- **GIVEN** an adapter returns normally
- **WHEN** the scanner finishes that iteration
- **THEN** exactly one heartbeat is sent, the one `runScan` already sends
- **AND** its reason is whichever the adapter derived, never `adapter_error`

## 2. A tool skipped by configuration says so

### Scenario: OWNMIND_SKIP_TOOLS names a tool

- **GIVEN** `OWNMIND_SKIP_TOOLS=codex`
- **WHEN** the scanner runs
- **THEN** the `codex` adapter does not scan
- **AND** a heartbeat is sent for `codex` with `reason: "skipped_by_config"`
- **AND** no `error` string is attached

### Scenario: OWNMIND_SKIP_TOOLS is empty or unset

- **GIVEN** `OWNMIND_SKIP_TOOLS` is unset
- **WHEN** the scanner runs
- **THEN** no `skipped_by_config` heartbeat is sent for any tool

## 3. The server accepts the two new reasons and keeps the free text out of the column

### Scenario: a heartbeat arrives with reason adapter_error

- **GIVEN** a POST to `/api/usage/events` with a heartbeat whose reason is `adapter_error`
- **WHEN** the server writes it
- **THEN** `collector_heartbeat.reason` is `adapter_error`
- **AND** the row's `status` follows the existing path (`active`)

### Scenario: the heartbeat carries an error message

- **GIVEN** a heartbeat with `reason: "adapter_error"` and a 4000-character `error`
- **WHEN** the server writes it
- **THEN** one `usage_audit_log` row is written with `event_type = 'collector_error'`
- **AND** its `details` hold the message truncated to at most 1000 characters,
  plus the tool, machine and scanner version
- **AND** `collector_heartbeat` gains no free-text column

### Scenario: an unknown reason arrives

- **GIVEN** a heartbeat whose reason is `banana`
- **WHEN** the server writes it
- **THEN** the stored reason is NULL, exactly as before this change
- **AND** no audit row is written

### Scenario: an error string arrives without an adapter_error reason

- **GIVEN** a heartbeat with `reason: "no_new_activity"` and an `error` string
- **WHEN** the server writes it
- **THEN** no `collector_error` audit row is written

Rationale: the audit row means "a collector crashed". Letting any heartbeat write one turns
it back into a log.

## 4. The round-trip check runs on the auto-update path, weekly

### Scenario: the marker is missing

- **GIVEN** `~/.ownmind/.last-usage-roundtrip` does not exist
- **WHEN** self-check runs with `--quick`
- **THEN** `usage_roundtrip` runs
- **AND** the marker is written with today's local date

### Scenario: the marker is older than 7 days

- **GIVEN** the marker holds a date 7 or more days before today
- **WHEN** self-check runs with `--quick`
- **THEN** `usage_roundtrip` runs and the marker is rewritten

### Scenario: the marker is within 7 days

- **GIVEN** the marker holds a date fewer than 7 days before today
- **WHEN** self-check runs with `--quick`
- **THEN** `usage_roundtrip` does not run
- **AND** it is absent from the uploaded report, as it is today

### Scenario: the marker is unreadable or malformed

- **GIVEN** the marker contains `not-a-date`, or cannot be read
- **WHEN** self-check runs with `--quick`
- **THEN** `usage_roundtrip` runs

Rationale: fail towards collecting. A machine whose disk is odd is a machine worth hearing from.

### Scenario: a full (non-quick) run

- **GIVEN** self-check runs without `--quick`
- **WHEN** it decides which checks to run
- **THEN** `usage_roundtrip` runs regardless of the marker
- **AND** the marker is rewritten, so a manual run resets the weekly clock

### Scenario: the marker cannot be written

- **GIVEN** `~/.ownmind` is read-only
- **WHEN** `usage_roundtrip` has just run
- **THEN** the failure to write the marker does not fail the check or the run
- **AND** the next quick run will run it again

## 5. What must not change

### Scenario: the reason set stays closed at the boundary

- **GIVEN** the two new codes are added to `shared/scanners/reasons.js`
- **WHEN** `isReason` is called with anything outside the set
- **THEN** it returns false, and the server stores NULL

### Scenario: a quick run's cost when the round-trip is not due

- **GIVEN** the marker is fresh
- **WHEN** self-check runs with `--quick`
- **THEN** no local database is scanned by self-check
