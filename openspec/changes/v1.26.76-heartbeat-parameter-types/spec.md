# v1.26.76 — Spec

## Requirement 1 — The heartbeat write is a statement Postgres accepts

### Scenario: a parameter that is both written and compared

- **GIVEN** an `INSERT ... SELECT` whose select list contains `$n`
- **AND** the same `$n` appears in a `WHERE` comparison against a typed column
- **THEN** the select-list occurrence carries an explicit cast

Without it the select-list occurrence is `unknown` and settles as `text`, the comparison
deduces `character varying`, and Postgres refuses to prepare the statement. Not a slow
query or a wrong row: no heartbeat at all.

### Scenario: the guard fails when a cast is removed

- **GIVEN** any single cast is deleted from the select list
- **THEN** the test goes red

Checked by mutation, because a test that asserts a property the code already has, and
would keep having if the code broke, proves nothing.

### Scenario: verified against a real database, not only a fake one

- **THEN** the statement is `PREPARE`d against Postgres before the version ships

Every existing test hands this route a fake `query` and never parses the SQL. That is the
gap this defect came through, and an assertion written in the same language as the gap
cannot close it on its own.

## Requirement 2 — Other statements of the same shape

### Scenario: a parameter used exactly once

- **GIVEN** `src/routes/broadcast.js` also uses `INSERT ... SELECT` with parameters
- **AND** each of its parameters appears exactly once in the statement
- **THEN** it needs no cast and is left alone

One occurrence means one deduction, and the INSERT coerces `unknown` into the target
column. Confirmed by `PREPARE` against the same database rather than by reasoning.
