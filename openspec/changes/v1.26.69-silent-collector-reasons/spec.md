# v1.26.69 — Spec

## Requirement 1 — An adapter that reports nothing reports why

Every adapter's `readSince` returns a `reason` from a closed set. The scanner puts it on
the heartbeat.

| reason | meaning |
|---|---|
| `ok` | read successfully and had something to report |
| `no_new_activity` | read successfully; nothing new since the last scan |
| `no_install` | nothing of this tool exists on this machine |
| `sqlite_missing` | the `sqlite3` CLI is absent, so this tool cannot be read at all |
| `unreadable` | the data exists but could not be opened |
| `account_changed` | the cursor belonged to a different account and was reset |

The set is closed on purpose. A free-text field becomes a log line, and a log line is
what this change exists to replace.

### Scenario: the tool is not installed

- **GIVEN** no candidate path for the tool exists
- **THEN** the reason is `no_install`

### Scenario: the CLI needed to read it is missing

- **GIVEN** the `sqlite3` CLI cannot be executed
- **THEN** the reason is `sqlite_missing`

Distinguishing this from `no_install` matters: one is a machine that does not have the
tool, the other is a machine that has the tool and a collector that cannot see it. On
Windows the second is a one-command fix and today it looks identical to the first.

### Scenario: installed, readable, nothing new

- **GIVEN** the telemetry reads cleanly and the day has not advanced
- **THEN** the reason is `no_new_activity`

This is the healthy quiet case and it must be distinguishable from every failure. It is
also what the v1.26.66 defect produced for eleven weeks, so `no_new_activity` on a tool
someone is visibly using is itself the signal that something upstream is wrong.

### Scenario: a directory exists but cannot be read

- **GIVEN** listing the data raises anything other than ENOENT
- **THEN** the reason is `unreadable`

Same rule as `defaultExists` in v1.26.66: only ENOENT is an answer, everything else is a
question that could not be answered.

## Requirement 2 — The server stores the reason in a column of its own

The reason gets a new column, `collector_heartbeat.reason varchar(32)`, added by
migration 018.

It does **not** reuse `collector_heartbeat.status`. That column is dead — `varchar(16)`,
written as the literal `'active'` in both halves of the upsert at
`src/routes/usage/events.js:421-428`, never selected by `loadClients` — but the name is
already taken at the layer above: `loadClients` computes its own per-client `status` of
`active` / `stale` / `offline` / `unknown` from heartbeat age
(`src/routes/usage/admin-clients.js:96-103`). Two different meanings under one name, one
in the database and one in the API, is how the next person gets it wrong. The dead column
is recorded in the backlog for removal instead.

### Scenario: the reason is stored

- **WHEN** a heartbeat arrives with a reason
- **THEN** `collector_heartbeat.reason` holds it and `status` is untouched

### Scenario: an unknown reason is rejected, not stored

- **GIVEN** a heartbeat whose reason is not in the closed set
- **THEN** `reason` is written as null

The set is closed at the boundary. A column sized to today's longest code, fed by
whatever a client sends, fails inside the ingest path where the failure costs the whole
batch.

### Scenario: an old client that sends no reason

- **GIVEN** a heartbeat with no reason field
- **THEN** `reason` is null and everything else behaves exactly as before

Collectors upgrade on their own schedule. TANK was running a collector four versions
behind on the day this was written.

### Scenario: a reason change is not swallowed by the rate limit

- **GIVEN** a heartbeat row written 5 seconds ago with reason `ok`
- **WHEN** a heartbeat arrives with reason `sqlite_missing`
- **THEN** the row is updated

The upsert is rate-limited to 30 seconds by
`WHERE collector_heartbeat.last_reported_at < NOW() - INTERVAL`. That is correct for
suppressing timestamp churn and wrong for suppressing a change of state. The condition
gains `OR collector_heartbeat.reason IS DISTINCT FROM EXCLUDED.reason`.

## Requirement 3 — The console shows the reason next to `silent`

### Scenario: a silent tool carries its reason

- **GIVEN** a user whose collector reports `sqlite_missing`
- **THEN** `observedUsers` marks them `silent` with that reason attached

`silent` was the right diagnosis and the wrong stopping point. It says a person is
working and the numbers are not arriving; it does not say which of five causes applies,
and the operator still has to open a terminal on that machine.

### Scenario: the state vocabulary does not change

- **THEN** `flowing`, `silent`, `not_installed` and `offline` keep their meanings

The reason is an attribute of the state, not a new state. v1.26.50 chose those four
deliberately.

## Requirement 4 — A cursor knows which account it belongs to

`~/.ownmind/cache/scanner-offsets.json` records an account fingerprint.

### Scenario: the same account

- **GIVEN** a cursor whose fingerprint matches the configured credentials
- **THEN** scanning continues from it, unchanged

### Scenario: the account changed

- **GIVEN** a cursor whose fingerprint does not match
- **THEN** the cursor is discarded, a new one is started, and the reason is
  `account_changed`

### Scenario: what the new account inherits

- **THEN** nothing. The new cursor starts at the current end of the data.

A usage tracker's job is attribution. Replaying a machine's history into whoever holds
the credentials now moves one person's work onto another person's name, which is worse
than the missing days this change exists to fix. Starting at "now" loses no future day
and claims no past one.

### Scenario: a first-ever install

- **GIVEN** no cursor file at all
- **THEN** scanning starts from the beginning, exactly as today

The distinction is a *change* of account on a machine that already had one, not the
absence of a cursor. A new install still gets its history.

### Scenario: the fingerprint is not the credential

- **THEN** the file contains a truncated SHA-256 of the API URL and key, never the key

The raw key already sits in `~/.claude/settings.json` on the same machine, so the
fingerprint discloses nothing new. It is a hash rather than the value itself so that a
file whose purpose is bookkeeping never becomes a second place a credential lives.

## Requirement 5 — This is a diagnosis, not a fix

### Scenario: a reason never suppresses collection

- **GIVEN** any reason other than `ok`
- **THEN** the scan still sends its heartbeat and any sessions it did find

Reporting why a collector is quiet must not become a reason for it to go quiet.
