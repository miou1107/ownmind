# v1.26.95 — Spec

## Requirement: the shell hooks log their fields where the server reads them

`log_event` in every shell hook MUST place its key/value pairs inside a `details` object,
and MUST NOT leave them at the top level. The endpoint the same function posts to reads
`e.details` and nothing else.

The line MUST remain valid JSON when there are no pairs at all — a hand-built object is
where a trailing comma appears, and an unparseable line is rejected in a way nobody sees.

The object written to the local log and the object uploaded MUST be the same one, so the
two cannot drift.

### Scenario: a failing upgrade step

- **GIVEN** `log_event "update_failed" "step" "pull"`
- **THEN** the logged line parses to `details: { step: "pull" }`, and carries no top-level
  `step`

### Scenario: several pairs

- **GIVEN** `log_event "iron_rule_trigger" "trigger" "deploy" "count" "27"`
- **THEN** `details` is `{ trigger: "deploy", count: "27" }` and `ts` / `event` / `tool` /
  `source` are unchanged

### Scenario: no pairs

- **GIVEN** `log_event "init"`
- **THEN** the line parses and `details` is `{}`

### Scenario: a value containing quotes and backslashes

- **GIVEN** a value of `C:\Users\Vin said "no"`
- **THEN** the line parses and the value round-trips exactly

### Scenario: end to end against the real endpoint

- **WHEN** the function runs with real credentials
- **THEN** the row stored on the server carries the same `details`, not `{}`

## Requirement: the tests execute the real function

The tests MUST source `log_event` out of each hook file and run it, rather than re-creating
its logic. A re-typed copy proves only that the copy works; the hook could drift and the
test would stay green. Output MUST be checked with `JSON.parse`, not by matching text — a
string assertion passes on output that is shaped right and still not valid JSON.
