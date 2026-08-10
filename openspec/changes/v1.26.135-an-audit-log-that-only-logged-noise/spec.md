# v1.26.135 — Spec delta: unknown-model auditing

## MODIFIED Requirement: unknown-model auditing

An ingested usage event whose `model` is not on the allowlist SHALL still be accepted and
stored. It SHALL cause an `unknown_model` row in `usage_audit_log` only when no such row
already exists for that `(tool, model)`.

### Scenario: a never-seen model is reported once

- **GIVEN** `usage_audit_log` holds no `unknown_model` row for `claude-code::claude-opus-5`
- **AND** `claude-opus-5` is absent from the allowlist
- **WHEN** a batch of three events for `claude-opus-5` is ingested
- **THEN** all three events are accepted
- **AND** exactly one `unknown_model` row exists for `claude-code::claude-opus-5`

### Scenario: a model already reported is not reported again

- **GIVEN** `usage_audit_log` already holds an `unknown_model` row for
  `claude-code::claude-opus-5`
- **WHEN** a further event for `claude-opus-5` is ingested
- **THEN** the event is accepted
- **AND** no additional `unknown_model` row is written

### Scenario: distinct unknown models in one batch each get a row

- **GIVEN** the allowlist contains `claude-code::known-one` only
- **WHEN** a batch containing `claude-opus-5`, `known-one`, `claude-sonnet-5` and a second
  `claude-opus-5` is ingested
- **THEN** `unknown_model` rows exist for `claude-opus-5` and `claude-sonnet-5`, one each
- **AND** no row exists for `known-one`

### Scenario: the batch's first message for a new model is a replay

- **GIVEN** `usage_audit_log` holds no row for `claude-code::brand-new-model`
- **AND** a batch whose first event for that model is already in `token_events`
- **AND** whose second event for that model is new
- **WHEN** the batch is ingested
- **THEN** the first event is counted as duplicated and the second accepted
- **AND** exactly one `unknown_model` row exists, carrying the second event's `message_id`

A model SHALL be claimed only by an event that was actually stored. A replay must not
consume the model's one chance to be reported.

### Scenario: every event in the batch is a replay

- **GIVEN** `usage_audit_log` holds no row for `claude-code::brand-new-model`
- **WHEN** a batch is ingested in which every event for that model is already stored
- **THEN** no `unknown_model` row is written

### Scenario: concurrent uploads of the same new model

- **GIVEN** two uploads carrying the same never-seen model are in flight
- **AND** both read "not yet reported" before either has inserted
- **WHEN** both attempt the insert
- **THEN** exactly one row is stored
- **AND** the losing insert is discarded without raising or logging a write failure

The insert SHALL name its conflict arbiter. A bare `ON CONFLICT DO NOTHING` would also
swallow unrelated unique violations on this table — a primary-key clash from a sequence left
behind a restored dump, for instance — and a `token_regression` row would then disappear with
no error and no log line.

## ADDED Requirement: the migration SHALL be safe on a database that still holds duplicates

`db/024` SHALL collapse existing duplicate `unknown_model` rows before creating the unique
index, and SHALL be re-runnable.

### Scenario: migrating a database that was never truncated

- **GIVEN** `usage_audit_log` holds several `unknown_model` rows for the same `(tool, model)`
- **AND** two `token_regression` rows for that same model
- **WHEN** `db/024` runs
- **THEN** one `unknown_model` row per `(tool, model)` remains
- **AND** both `token_regression` rows remain
- **AND** running it a second time changes nothing and does not raise

## ADDED Requirement: audit rows for other event types stay per-message

`token_regression`, `fingerprint_mismatch` and `fingerprint_collision` rows SHALL continue to
be written once per affected message. The uniqueness constraint introduced for
`unknown_model` SHALL NOT apply to them.

### Scenario: two regressions in one session both recorded

- **GIVEN** a session whose cumulative token count regresses twice
- **WHEN** both events are ingested
- **THEN** two `token_regression` rows exist
