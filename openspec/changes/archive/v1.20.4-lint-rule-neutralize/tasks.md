# v1.20.4 — Task list

1. Write `shared/lint-event-types.js` (event constants + Chinese event name mapping table)
2. Change `shared/language-lint.js`: violation list rule uses constants, comments remove IR-036/IR-037
3. Change `hooks/ownmind-reply-lint.js`: message rendering formatBlockReason / formatViolations uses neutral event names
4. Change `hooks/lib/build-compliance-events.js`: map events to rule_code via rule metadata
5. Change `hooks/lib/lint-event-logger.js`: event field uses constants
6. Clean `shared/bug-fingerprints.js:106` description to remove IR-036
7. Update tests (lint-event-logger / build-compliance-events / reply-lint-hook / reply-lint-pending-spool / flush-compliance-spool / iron-rule-origin-context) for the new constants
8. Update Vin's personal iron rules IR-036 + IR-037 metadata to add `triggered_by_event`
9. Version 1.20.3 → 1.20.4 + CHANGELOG + FILELIST + tri-language README
10. cp sync ~/.ownmind/ + verification + code-review compliance + commit + push
