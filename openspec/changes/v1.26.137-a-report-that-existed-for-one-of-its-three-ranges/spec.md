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

- **WHEN** the friction section is condensed
- **THEN** every entry is still present
- **AND** every project that had friction still has friction

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
