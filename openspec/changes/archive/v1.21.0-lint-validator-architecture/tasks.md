# v1.21.0 — Task list

1. New `shared/validators/` directory + 3 modules
   - jargon-explanation.js (wraps the existing checkJargonExplanation)
   - language-mixed-ratio.js (wraps the existing checkMixedLanguage)
   - privacy-detect.js (extracted from hooks/ownmind-reply-lint.js)
   - index.js registry + findValidator / listAvailableValidators

2. Write validator unit tests `tests/validators/`:
   - jargon-explanation.test.js
   - language-mixed-ratio.test.js
   - privacy-detect.test.js
   - registry.test.js

3. Change `shared/language-lint.js`:
   - lintReply accepts enabledValidators as the second parameter
   - internally loops and runs each validator.check
   - violations get a sourceRule field
   - the existing two check functions are kept (used internally by validators)

4. Change `hooks/ownmind-reply-lint.js`:
   - new helper extractEnabledValidators(rulesCache)
   - feed enabledValidators to lintReply
   - remove the internal privacy_check direct-run, switch to the validator interface
   - render sourceRule in the violation list (if present)

5. Change `hooks/lib/build-compliance-events.js`:
   - violation.sourceRule (if present) → use directly as rule_code, no need to go through findUserRuleByEvent

6. Change Vin's personal iron-rule metadata:
   - IR-036 (id=300) add lint_validator: { name: 'jargon_explanation', params: {} }
   - IR-037 (id=312) add lint_validator: { name: 'language_mixed_ratio', params: { threshold: 0.15 } }

7. Align existing tests to the new architecture:
   - tests/reply-lint.test.js
   - tests/reply-lint-hook.test.js
   - tests/build-compliance-events.test.js
   - other tests that use lintReply / violations

8. Version 1.20.4 → 1.21.0 + trilingual README + CHANGELOG + FILELIST

9. cp-sync ~/.ownmind/ + verification + code-review compliance + commit + push
