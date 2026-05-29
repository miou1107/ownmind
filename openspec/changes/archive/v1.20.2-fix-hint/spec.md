# v1.20.2 — Spec: add a concrete call example to the recent_event_exists failure message

## Scenario 1: failure message contains a concrete ownmind_report_compliance call example

**GIVEN** an IR-025 verification condition `{ type: 'recent_event_exists', params: { event: 'verification', action: 'comply' } }`
**AND** the compliance records `ctx.complianceEvents` contain no record with `event='verification' AND action='comply'`
**WHEN** running `evaluateConditions(conditions, ctx)`
**THEN** it returns `{ pass: false, failures: [...] }`
**AND** the `failures[0]` string must contain the literals:
  - `ownmind_report_compliance`
  - `rule_title: 'verification'` (or `rule_title="verification"`)
  - `action: 'comply'` (or `action="comply"`)
**AND** the `failures[0]` string must contain a "do not pass rule_code" style hint (plainly telling the AI not to mistakenly pass rule_code and trigger the fallback logic)

## Scenario 2: a missing code-review event also produces a concrete call example

**GIVEN** a condition `{ type: 'recent_event_exists', params: { event: 'code-review', action: 'comply' } }`
**AND** the compliance records have no matching event
**WHEN** running `evaluateConditions`
**THEN** `failures[0]` contains `rule_title: 'code-review'` + `action: 'comply'` + the do-not-pass-rule_code hint

## Scenario 3: previously passing conditions are unaffected

**GIVEN** the compliance records already contain `{ event: 'verification', action: 'comply' }`
**WHEN** running `evaluateConditions` with the same condition
**THEN** it returns `{ pass: true, failures: [] }`

## Scenario 4: hint text of other CHECK_HANDLERS is unchanged

**GIVEN** a `staged_files_include` condition fails
**WHEN** running `evaluateConditions`
**THEN** `failures[0]` keeps the original format "..., please git add ... and retry", unaffected

## Scenario 5: failure message keeps the original rule message prefix + length cap

**GIVEN** `recent_event_exists` fails
**WHEN** running `evaluateConditions`
**THEN** `failures[0]` still starts with the rule's own `message` (e.g. "verification not done yet"), with the concrete call example appended after it
**AND** `failures[0].length <= 250` (a single failure message does not exceed 250 chars)

## Non-functional requirements

- **Zero external dependencies**: `verification.js` is still a pure-function module, no new packages introduced
- **Backward compatible**: when the context is missing complianceEvents, the handler still returns true (skips the check), behavior unchanged
- **Other CHECK_HANDLERS unaffected**: see Scenario 4; the hint text of `staged_files_include` / `staged_files_exclude` / `commit_message_*` etc. stays as-is
