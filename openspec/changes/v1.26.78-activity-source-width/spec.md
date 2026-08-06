# v1.26.78 — Spec

## Requirement 1 — The column fits the values written to it

### Scenario: a source value from any client

- **GIVEN** any `source: '...'` literal in `mcp/`, `hooks/`, `shared/` or `src/`
- **THEN** it fits `activity_logs.source`

`mcp/ownmind-log.js` lifts `details.source` into the column, so any of these can become the
stored value.

### Scenario: room for the next one

- **THEN** the column is at least eight characters wider than the longest current value

Sizing to today's longest string is the same defect waiting for tomorrow's.

### Scenario: a client that will never be upgraded

- **GIVEN** a machine still running v1.26.29
- **THEN** its events are accepted

This is why the column is widened rather than the strings shortened. The values are on
installed clients, not only in this repository.

## Requirement 2 — One rejected event costs one event

### Scenario: a batch containing one row the database refuses

- **THEN** the other events in the batch are still stored
- **AND** the response reports how many failed
- **AND** the log names the event type and source that failed

Previously the whole request 500'd and the client's spool retried the same batch forever.
A single anonymous "batch upload failed" also named nothing, which is why this went
unnoticed for the life of the table.

### Scenario: what this requirement is not

- **THEN** the isolation is asserted by reading the handler, not by driving it

`POST /api/activity/batch` uses the module-level `query` import, so no test can make one
event fail inside the real loop. Stated here rather than left for a reader to discover, and
the refactor that would close it is in the backlog.
