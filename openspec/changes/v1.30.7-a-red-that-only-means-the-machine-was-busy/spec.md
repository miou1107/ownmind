# Spec — a failing test means the code is wrong

## Requirement 1 — the parity file does not fail for being slow

### Scenario: a loaded parallel suite run

- **GIVEN** `tests/iron-rule-trigger-parity.test.js` runs alongside the rest of the suite
- **THEN** it MUST NOT fail on the test timeout

Its assertion message says the shell hook disagrees with `shared/helpers.js`. That sentence must
only ever appear when it is true.

### Scenario: the work is done once, ahead of the assertions

- **GIVEN** the file's set of commands
- **WHEN** the suite starts the file
- **THEN** each command MUST be classified exactly once, with bounded concurrency
- **AND** each test MUST read its recorded answer rather than spawn again

### Scenario: a command with no recorded answer

- **THEN** that test MUST fail, naming the command

Reading a missing entry as `undefined` and comparing it would fail anyway, but with a message
about a trigger mismatch rather than about setup — the same misdirection this release is about.

## Requirement 2 — one test per command survives

### Scenario: the shell classifier genuinely drifts

- **GIVEN** one command the shell hook classifies differently from `shared/helpers.js`
- **THEN** exactly that command's test MUST fail, with the command in its name

The file is thirty tests rather than one loop on purpose: a single failing case has to name
itself. Collapsing them into one assertion would be faster still and would report "one of these
thirty is wrong".

## Requirement 3 — each spawn is its own session

### Scenario: the once-an-hour window

- **GIVEN** the hook keys that window on `session_id`
- **THEN** each spawned classification MUST supply a distinct one

Without it every spawn shares the key `default`. In sequence that is a hidden coupling — only
the first run sees a full listing. Concurrently it is thirty processes writing one state file.

## Out of scope

`tests/reset-admin-password-script.test.js`, which timed out in the same run and takes under a
second alone. It was collateral. If it times out again once this file is quick, that is new
information.
