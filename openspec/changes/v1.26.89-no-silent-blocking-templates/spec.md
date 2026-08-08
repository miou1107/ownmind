# v1.26.89 — Spec

## Requirement: a matched verification template is never applied automatically

Saving or updating an `iron_rule` MUST NOT write `metadata.verification` as a consequence of
a template match. The match MAY be reported; it MUST NOT take effect.

### Scenario: the rule from the bug report

- **GIVEN** a rule about preserving logs during rollback, tagged `trigger:deploy`, whose
  body contains 測試 once in passing
- **WHEN** it is saved
- **THEN** the stored rule carries no `metadata.verification`
- **AND** the response reports `deploy_requires_test` as a suggestion

### Scenario: a rule that already carries a verification block

- **GIVEN** a rule whose `metadata.verification` is already set
- **WHEN** it is saved
- **THEN** no template is suggested and the existing value is untouched

## Requirement: a suggestion must be legible to the caller

The response MUST carry `template_suggestion` with the template's human-readable name, an
explicit `applied: false`, whether the template blocks work, and a message that can be
relayed to the rule's author unchanged.

A bare id is not sufficient: `matched_template` on its own is what let the previous
behaviour go unnoticed.

### Scenario: an AI client relays the suggestion

- **GIVEN** a save that matches a template
- **WHEN** the client reads the response
- **THEN** `template_suggestion.applied` is `false`
- **AND** `template_suggestion.blocks_work` says whether accepting it would stop work
- **AND** `template_suggestion.message` states that nothing was applied

## Requirement: the exception, if one is ever made, is for non-blocking templates only

If a template that does not block work is added, whether it may auto-apply is a decision to
be taken then, on the record. A test MUST fail if a non-blocking template is added, so the
question is asked rather than assumed.

### Scenario: someone adds a reminder-only template

- **GIVEN** a new template with `block_on_fail: false`
- **WHEN** the test suite runs
- **THEN** it fails, pointing at the decision that was made while the set was all-blocking
