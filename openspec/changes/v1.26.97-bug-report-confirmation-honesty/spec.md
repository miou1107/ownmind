# v1.26.97 — Spec

## Requirement: an undeclared confirmation is recorded as unknown

The server MUST record `confirmation_declared` for every bug report. Only `user_typed` and
`ai_filled` may be stored from the client; anything absent, unrecognised or of the wrong
type MUST become `unknown`.

`unknown` MUST NOT be a value a client can declare directly, so the field keeps
distinguishing "said nothing" from "said unknown".

### Scenario: an older client that does not send the field

- **WHEN** a report arrives with no `confirmation_declared`
- **THEN** the row records `unknown`, not `user_typed`

### Scenario: a client sends something else

- **GIVEN** any of `''`, `'USER_TYPED'`, `0`, `true`, `{}`, `'__proto__'`
- **THEN** the row records `unknown`

## Requirement: the tool description does not claim enforcement

The `ownmind_report_bug` description MUST NOT state that the backend rejects auto-filled
submissions, and MUST state that the server checks the value only and cannot see who typed
it. `confirmation_declared` MUST be a required, enumerated parameter.

A control whose description claims a check it does not perform is worse than no control:
it is believed.

### Scenario: reading the tool description

- **THEN** it contains no claim of backend rejection, and does say the server cannot tell
  who produced `confirm_string`

## Requirement: the normalisation is shared, not duplicated

The route MUST import the normaliser rather than repeat the value list, so the route and
its tests cannot drift into disagreeing about what counts — the same arrangement as
`src/utils/activity-insert.js`.

### Scenario: someone changes the accepted values

- **WHEN** the list in `src/utils/confirmation-declared.js` changes
- **THEN** the route's behaviour changes with it, with no second place to update
