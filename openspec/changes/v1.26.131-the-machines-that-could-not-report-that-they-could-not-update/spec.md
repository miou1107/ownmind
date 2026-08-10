# v1.26.131 — Spec

## Requirement: the log directory does not depend on $HOME

`mcp/ownmind-log.js` MUST resolve an absolute directory on every platform.

### Scenario: Windows, where HOME is unset

- **GIVEN** `process.env.HOME` is not set
- **WHEN** the logs directory is resolved
- **THEN** it is absolute, under the user's profile — not relative to the working directory
  the host launched the MCP in

### Scenario: the empty-string fallback returns

- **GIVEN** the resolver is written as `process.env.HOME || ''`
- **WHEN** the suite runs
- **THEN** it fails, on the expression rather than on the prose describing it

## Requirement: the two copies of an event fail independently

### Scenario: the logs directory cannot be written

- **GIVEN** the local log file cannot be created
- **WHEN** an event is logged
- **THEN** it still reaches the upload buffer — a filesystem problem costs the local copy
  only, never the copy anybody can look at

### Scenario: the write is moved back in front of the buffer

- **GIVEN** `appendFileSync` runs before `buffer.push`
- **WHEN** the suite runs
- **THEN** it fails, because a throw there deletes the event outright

## Requirement: update outcomes are not batched

An update outcome MUST be sent when it happens.

### Scenario: the host terminates the MCP without a signal

- **GIVEN** the process is killed rather than signalled, before the thirty-second timer
- **WHEN** the daily update has already recorded its outcome
- **THEN** the server has it, because the event was flushed on the spot

### Scenario: an outcome is dropped from the immediate set

- **GIVEN** any of `update_applied`, `update_failed`, `update_skipped`, `update_clean` is
  removed from `IMMEDIATE_FLUSH_EVENTS`
- **WHEN** the suite runs
- **THEN** it fails, naming that event
