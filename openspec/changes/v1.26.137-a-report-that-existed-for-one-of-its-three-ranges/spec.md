# v1.26.137 — Spec delta: the insights payload is sized to what the upstream accepts

## ADDED Requirement: the request SHALL be brought within the upstream's size limit

The insights payload SHALL be condensed until the request body is within the measured
limit, and SHALL be measured using the same function that builds the posted body.

### Scenario: a range that has always fitted

- **GIVEN** the 7-day report, whose request body measures 32,372 bytes
- **WHEN** insights are requested
- **THEN** the payload is sent unchanged
- **AND** the response carries no note about condensing

### Scenario: a range that did not fit

- **GIVEN** the 30-day report, whose request body measures 52,842 bytes
- **WHEN** insights are requested
- **THEN** the body posted upstream is under the measured limit
- **AND** a report is returned rather than an error

## ADDED Requirement: condensing SHALL preserve what each section is read for

### Scenario: friction is shortened, never dropped

- **WHEN** truncating the friction notes is enough to fit
- **THEN** every entry is still present
- **AND** every project that had friction still has friction

### Scenario: truncation alone is not enough

- **WHEN** the payload is still over budget after every friction note is at its shortest
- **THEN** entries may be dropped by the last-resort trim
- **AND** the notes say how many were left out
- **AND** no note claims that nothing was dropped

### Scenario: the compliance rows that matter survive

- **WHEN** the compliance section is condensed
- **THEN** every row with a violation or a skip is kept
- **AND** the number of fully-compliant rows left out is stated

### Scenario: the version collapse keeps the oldest version per machine

- **GIVEN** a machine reporting 1.26.27 for one tool and 1.26.135 for another
- **WHEN** the version list is collapsed
- **THEN** the row for that machine reads 1.26.27

## ADDED Requirement: a condensed report SHALL say so

### Scenario: the reader is told what was summarised

- **WHEN** any condensing happened
- **THEN** the response lists what was condensed
- **AND** the model's input carries the same list

### Scenario: nothing was condensed

- **WHEN** the payload already fitted
- **THEN** the response carries no such list

## ADDED Requirement: the model SHALL be told when it is reading a summary

The system prompt SHALL instruct the model that `_condensed` marks summarised sections, that
it must state the scope of what it saw when writing about them, and that it must not infer
totals or proportions for those sections.

### Scenario: the compliance section holds only violations

- **GIVEN** the compliance rows without a violation or skip were dropped
- **WHEN** the model writes the explanation for that section
- **THEN** it states that only rows with a violation or skip are shown
- **AND** it does not describe the team's overall compliance as poor

## ADDED Requirement: an unreadable version SHALL NOT replace a readable one

`scanner_version` is nullable and reaches this code as `null` or `"unknown"`.

### Scenario: one tool on a machine has never reported its version

- **GIVEN** a machine reporting 1.26.135 for one tool and null for another
- **WHEN** the version list is collapsed
- **THEN** the row for that machine reads 1.26.135

### Scenario: a machine has no readable version at all

- **WHEN** the version list is collapsed
- **THEN** the machine is still listed, with the unreadable value
