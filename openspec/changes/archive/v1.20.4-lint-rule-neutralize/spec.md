# v1.20.4 — Spec: Lint rule neutralization

## Scenario 1: lintReply violation list uses neutral event constants

**GIVEN** content with a Chinese-English mix over 15%
**WHEN** lintReply(content) is called
**THEN** the first entry's `rule` field in the violation list = the string `'lint_language_mixed_ratio'`
**AND NOT** contains the string `'IR-037'`

## Scenario 2: lintReply violation list jargon event

**GIVEN** content with unexplained jargon
**WHEN** lintReply(content) is called
**THEN** that entry's `rule` field in the violation list = the string `'lint_jargon_explanation_required'`
**AND NOT** contains the string `'IR-036'`

## Scenario 3: message rendering contains no personal iron-rule number

**GIVEN** the lint hook detects a violation and is about to block
**WHEN** formatBlockReason(violations) is called
**THEN** the returned string contains neither "IR-036" nor "IR-037"
**AND** contains a Chinese event description (e.g. 「行話品質」/「中英混雜」)

## Scenario 4: compliance record maps to the personal number via the rule

**GIVEN** the rule cache has Vin's IR-036, metadata.triggered_by_event = 'lint_jargon_explanation_required'
**AND** the violation list has `{ rule: 'lint_jargon_explanation_required' }`
**WHEN** buildComplianceEvents(violations, rules, getTier) is called
**THEN** the returned event details.rule_code = 'IR-036'
**AND** details.tier is looked up from the rule cache

## Scenario 5: no match in the rule cache → fallback leaves empty

**GIVEN** no rule in the rule cache has a triggered_by_event field
**AND** the violation list has `{ rule: 'lint_jargon_explanation_required' }`
**WHEN** buildComplianceEvents is called
**THEN** the returned event details.rule_code = '' (empty string)
**AND** details.message contains the Chinese event description
**AND** does not crash

## Scenario 6: bug-fingerprints description contains no personal number

**GIVEN** reading the `lint_context_memory_missing` registration entry in `shared/bug-fingerprints.js`
**THEN** the description does not contain the "IR-036" string
**AND** still clearly describes the problem (using the neutral name 「行話判斷」)

## Scenario 7: lint-event-logger writes using event constants

**GIVEN** the violation list rule uses the constant `'lint_jargon_explanation_required'`
**WHEN** writeLintEvent({ ruleCodes: ['lint_jargon_explanation_required'], ... }) is called
**THEN** the rule_codes field written to jsonl = that constant
**AND** the parser / stats tools can recognize it

## Non-functional requirements

- **Zero external dependencies**: `lint-event-types.js` is a pure constant module, no IO
- **Backward-compatible tests**: after all existing tests are updated, npm test is all green
- **Local hook takes effect immediately**: cp 5 files to ~/.ownmind/ and it takes effect (the hook spawns a new process)
