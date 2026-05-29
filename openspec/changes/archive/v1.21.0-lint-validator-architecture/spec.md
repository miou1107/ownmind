# v1.21.0 — Spec: Lint validator architecture

## Scenario 1: validator package interface contract

**GIVEN** the validator module `shared/validators/jargon-explanation.js`
**THEN** that module exports at least:
  - `name` (string, the validator identifier)
  - the `check(content, params, context)` function
**AND** the return value of `check` matches `{ ok: boolean, violation?: { event, message, detail } }`

## Scenario 2: a rule enables a validator → the hook runs that check

**GIVEN** the user iron rule IR-036 metadata contains `lint_validator: { name: 'jargon_explanation', params: {} }`
**AND** the lint hook reads that rule
**WHEN** running `lintReply(content, enabledValidators)`
**THEN** the corresponding validator.check is called
**AND** the violation list contains `{ event: 'lint_jargon_explanation_required', sourceRule: 'IR-036' }`

## Scenario 3: a rule does not enable a validator → the hook skips

**GIVEN** no rule in the user iron-rule cache sets `lint_validator`
**WHEN** the lint hook runs
**THEN** `enabledValidators` is an empty array
**AND** the `lintReply` violation list is empty
**AND** the hook exits 0, does not block

## Scenario 4: a rule enables an unregistered validator → safely skipped

**GIVEN** a rule metadata contains `lint_validator: { name: 'nonexistent_validator' }`
**WHEN** the hook calls `findValidator('nonexistent_validator')`
**THEN** it returns null
**AND** does not crash, skips that rule and continues processing other rules

## Scenario 5: params are passed to the validator

**GIVEN** IR-037 metadata contains `lint_validator: { name: 'language_mixed_ratio', params: { threshold: 0.20 } }`
**WHEN** the validator runs
**THEN** `check` receives `params = { threshold: 0.20 }`
**AND** uses that threshold to replace the default 0.15

## Scenario 6: the violation list contains sourceRule mapping back to the original rule

**GIVEN** Vin's IR-036 enables the jargon_explanation validator
**WHEN** some reply violates
**THEN** the violation list records `sourceRule: 'IR-036'`
**AND** `buildComplianceEvents` uses that sourceRule as the rule_code (no need to go through triggered_by_event lookup)

## Scenario 7: rule cache empty / corrupt → fail-open

**GIVEN** `~/.ownmind/cache/iron_rules.json` does not exist or is corrupt
**WHEN** the lint hook runs
**THEN** `enabledValidators` is empty
**AND** the hook exits 0, silent
**AND** does not block the user

## Scenario 8: the privacy_detect validator replaces the existing inline logic

**GIVEN** the user enables the privacy_detect validator
**AND** the reply contains an email address
**WHEN** validator.check runs
**THEN** the violation list contains `{ event: 'lint_privacy_check', ... }`
**AND** detail.matches does not leak the original value (privacy protection)

## Non-functional requirements

- **Zero external dependencies**: validator packages are pure functions, no new packages introduced
- **Backward compatibility**: the existing lintReply API keeps a compatible signature (accepting `content, historicalCorpus` still works, but internally uses the new flow)
- **fail-open**: any failure reading rules / finding a validator is always "treated as not enabled, silent", does not block the user
