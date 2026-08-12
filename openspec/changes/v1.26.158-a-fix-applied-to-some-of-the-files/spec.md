# Spec — no test dials a port it drew without checking

## Requirement 1 — a file that listens and fetches goes through the helper

### Scenario: any test file

- **GIVEN** a file under `tests/` that calls `.listen(0)` **and** uses `fetch(`
- **THEN** it MUST import `startServer` from `./helpers/app-server.js`

The helper redraws when the OS hands back a port on the WHATWG blocked list. Without it the
file dials a number `fetch` refuses, and the failure names neither the test nor the code.

### Scenario: the twelve migrated in this release

- **GIVEN** any of the twelve files converted here
- **THEN** removing the import fails the guard **naming that file**

A drifting red that lands on a different file each run is what this whole line of work has been
about. The failure has to name a file.

### Scenario: exemptions

- **GIVEN** the helper's own test, or this guard itself
- **THEN** they are exempt

### Scenario: a raw socket

- **GIVEN** a file that calls `.listen(0)` and writes to it with `net.connect` rather than
  `fetch`
- **THEN** the guard is satisfied as long as the file imports the helper

Blocked ports are a `fetch` rule. A raw socket dials anything. The rule is "this file cannot
dial an unchecked port with `fetch`", not "this file may never call listen".

## Requirement 2 — the guard states its own premise

### Scenario: the runtime still refuses blocked ports

- **WHEN** the guard runs
- **THEN** it asserts that `fetch('http://127.0.0.1:6000/')` rejects with `bad port`
- **AND** that an ordinary high port is not on the list

If a future runtime stops refusing them, this fails and says so, and the helper and the guard
can both be deleted. Without it the premise could expire quietly, leaving a redraw nobody can
justify and a rule nobody can question.

## Out of scope

No product code changes. This release is entirely inside `tests/`.
