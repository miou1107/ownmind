# v1.26.148 — Spec delta: the tip SHALL name the standards this account can ask for

## ADDED Requirement: a team standard SHALL be able to declare itself askable

A `team_standard` MAY carry `metadata.user_invocable: true` together with
`metadata.invocation_hint`, a single-line sentence of at most 120 characters written in the
words a user would say. Both are required together.

### Scenario: marking a standard

- **GIVEN** a `team_standard` and an admin caller
- **WHEN** they set `user_invocable: true` and a non-empty `invocation_hint`
- **THEN** the write succeeds

### Scenario: the flag without the sentence

- **WHEN** a write sets `user_invocable: true` with no `invocation_hint`, or an empty one
- **THEN** the response is 400
- **AND** the error names the missing field
- **AND** the response carries an example of the sentence to write

### Scenario: a hint that does not fit the line it is shown on

- **WHEN** `invocation_hint` exceeds 120 characters, or contains a newline
- **THEN** the response is 400

### Scenario: the flag on a memory nobody else can see

- **GIVEN** the memory's type is anything other than `team_standard`
- **WHEN** a write sets `user_invocable: true`
- **THEN** the response is 400
- **AND** the error says the field applies to team standards only

### Scenario: a memory that says nothing about this

- **GIVEN** metadata with neither field, or no metadata at all
- **WHEN** it is created or updated
- **THEN** the write behaves exactly as it did before this change

### Scenario: the flag explicitly set to false

- **WHEN** `user_invocable: false` is stored with no hint
- **THEN** the write succeeds and the standard never appears in a tip

## ADDED Requirement: session start SHALL carry the account's askable standards

`GET /api/memory/init` SHALL return `invocable_standards`, an array of
`{ id, title, hint }` built from the team standards the caller can see.

### Scenario: an account with marked standards

- **THEN** each marked standard appears once, in the order the standards are loaded
- **AND** the field is present whether or not `compact` was requested

### Scenario: an account with none

- **THEN** the field is an empty array
- **AND** no other part of the response changes

### Scenario: a standard flagged without a usable hint

- **GIVEN** a row carrying `user_invocable: true` and no hint — reachable for rows written
  before the validation, or written directly to the database
- **THEN** it is omitted from `invocable_standards`
- **AND** its title is never substituted for the missing sentence

### Scenario: two standards with the same sentence

- **THEN** the sentence appears once, so one request is not shown twice as often

## MODIFIED Requirement: the tip SHALL prefer the account's own sentences

`getRandomTip()` accepts the account's hints. When any are supplied, they replace the static
team-standard tip in the pool; the rest of the pool is unchanged.

### Scenario: an account with marked standards

- **WHEN** tips are drawn repeatedly
- **THEN** the marked sentences appear
- **AND** the static "OwnMind has team standards" line does not
- **AND** the other product tips still appear

### Scenario: an account with none

- **WHEN** tips are drawn repeatedly
- **THEN** every tip comes from the static pool, the static team-standard line included

### Scenario: a malformed or empty hint list

- **GIVEN** the hints are absent, empty, or not an array
- **THEN** the tip is drawn from the static pool with no error

### Scenario: two calls in a row

- **THEN** the second tip differs from the first, whether either came from the pool or the
  account's own sentences

## ADDED Requirement: both tip surfaces SHALL use the same list

### Scenario: session start

- **WHEN** the SessionStart hook renders its context
- **THEN** its tip is drawn with the hints from the init response it already holds
- **AND** no additional request is made for them

### Scenario: every MCP tool response

- **GIVEN** the MCP process has completed an init
- **WHEN** any tool responds
- **THEN** its tip is drawn with the hints learned at init
- **AND** the tip is still attached unconditionally, as it has been since v1.17.7

## Unchanged

- The tip pool rendered into the operations manual (`renderTipPool()`) still lists the static
  tips and their anchors; a company's own sentences are per-account and not part of it.
- Who may write a team standard is unchanged (v1.26.147: its owner, or an admin).
- No standard is marked by this change; marking is data, done after deploy.
