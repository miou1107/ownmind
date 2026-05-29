# v1.21.0 — Lint validator architecture (rule-driven, user opt-in)

## One-sentence summary

Change the lint logic from "hard-coded into the OwnMind system" to "driven by the user's iron rules". Each user declares in their own iron-rule metadata which validator package to enable, and the OwnMind hook only runs the checks that user enabled. Other users are not forced into Vin's personal language preferences.

## Background

On 2026-05-26 Vin caught that, although v1.20.4 made the user-facing messages neutral (the IR-036 string was changed to "jargon quality"), the root problem was not solved:

**`shared/language-lint.js` hard-codes the two check functions `checkJargonExplanation` and `checkMixedLanguage`, and all users are forced to run them**.

Other users like Alice do not have the "mixed Chinese/English" and "jargon quality" iron rules, but the OwnMind hook still blocks their replies. This violates OwnMind's core principle "memory belongs to the user" — the lint logic should also belong to the user, not be system built-in.

## In scope

- New `shared/validators/` directory with 3 validator modules:
  - `jargon-explanation.js` (jargon quality check, wrapping the original checkJargonExplanation logic)
  - `language-mixed-ratio.js` (mixed Chinese/English check, wrapping the original checkMixedLanguage logic)
  - `privacy-detect.js` (privacy detection, extracted from hooks/ownmind-reply-lint.js)
- New `shared/validators/index.js`: registry + `findValidator` / `listAvailableValidators`
- Change `lintReply` in `shared/language-lint.js`: accept an `enabledValidators` parameter, rule-driven
- Change `hooks/ownmind-reply-lint.js`: scan the rule cache for iron rules that have a `lint_validator` setting and run the corresponding checks
- New field `lint_validator: { name, params }` in user iron-rule metadata
- Add lint_validator enablement to Vin's own IR-036 / IR-037, keeping backward-identical behavior
- Align existing tests to the new architecture

## Out of scope

- ❌ Auto-migrating existing rules: if a user does not manually add `lint_validator` it is not enabled, do not infer on the user's behalf
- ❌ Dashboard / UI offering a "validator package catalog" for users to choose: leave for a later version
- ❌ Third-party custom validators: this version only supports the 3 built-in packages, plugins are opened up later
- ❌ Validator package marketplace: too far off, not in scope

## Design points

### Validator package interface

Each validator is a pure-function module that exports:

```js
export const name = 'jargon_explanation';
export function check(content, params = {}, context = {}) {
  // params: the settings the user passed in from metadata (optional)
  // context: { historicalCorpus, userPrompts, ... }
  // return: { ok: true } or { ok: false, violation: { event, message, detail } }
}
```

### User iron-rule metadata design

```json
// IR-036 (Vin's "jargon quality" iron rule)
{
  "lint_validator": {
    "name": "jargon_explanation",
    "params": {}
  },
  "triggered_by_event": "lint_jargon_explanation_required"
}

// IR-037 (mixed Chinese/English)
{
  "lint_validator": {
    "name": "language_mixed_ratio",
    "params": { "threshold": 0.15 }
  },
  "triggered_by_event": "lint_language_mixed_ratio"
}

// a rule with no lint_validator set → the hook does not run that check at all
```

### Hook flow rework

Old (v1.20.4):
```
lintReply(content, historicalCorpus)
  → hard-runs checkMixedLanguage + checkJargonExplanation
  → returns violations
```

New (v1.21.0):
```
extractEnabledValidators(rulesCache)
  → scans the user's iron rules for lint_validator settings
  → returns [{rule, validator, params}, ...]
lintReply(content, enabledValidators, context)
  → loops and runs each validator.check
  → returns violations + sourceRule mapping
```

### Backward compatibility

- For Vin: via `ownmind_update`, add `lint_validator` metadata to IR-036 / IR-037, behavior is the same as v1.20.4
- For other users (Alice / future additions): no metadata set = the hook does not block at all = silent
- The hook itself: when no enabledValidator is found → exit 0, do not block

## Version decision

v1.21.0, a minor rather than a patch. Reasons:
- This is a major architectural change, a new validator interface + a rule-driven flow
- Existing users must manually add metadata to keep enforcing (breaks the existing default behavior)
- Matches semver: minor means "new feature + may change the default behavior but does not break the API"

## Risks

- **Existing lint enforcement temporarily silent**: Vin's own IR-036 / IR-037 need metadata added, otherwise lint won't block Vin after v1.21 ships. Manual updating is controllable
- **Rule cache read failure**: fail-open (in plain terms: if the user's iron rules can't be read, treat it as no validator enabled, silent)
- **Validator package upgrades are hard**: an API change in a package must accommodate the `params` format in user metadata, a new version adds fields but does not remove old ones
- **Test rewrite**: the existing 6 test files must align to the "rule-driven" style, a medium amount of engineering
