# v1.20.4 — Lint rule neutralization (remove personal iron-rule numbers from product code)

## One-line summary

The OwnMind product code hardcodes Vin's personal iron-rule numbers (`IR-036` / `IR-037`), which leak to other users (plain English: when others use OwnMind, they should not see Vin's private numbers). Switch to neutral event constants and decouple the rules from the product code. This violates Vin's IR-050 (personal iron-rule numbers must not be written into product code or public docs).

## Background

On 2026-05-26, Alice (another AI session) saw the phrase "previous response violated IR-036" appear in his own conversation, which Vin caught. After grepping, the findings were:

- `shared/language-lint.js`: `rule: 'IR-037'` / `rule: 'IR-036'` hardcoded in the violation list
- `hooks/ownmind-reply-lint.js`: `if (v.rule === 'IR-037')` / `if (v.rule === 'IR-036')` message rendering branches
- `hooks/lib/lint-event-logger.js`: event record field
- `shared/bug-fingerprints.js:106`: the fingerprint description I newly added in v1.20.2 follow-up #3 also wrote IR-036 (my responsibility)

The whole chain: the lint hook emits a standard error message containing "IR-036" → the AI receives the instruction and copies "IR-036" when writing the rewrite annotation → other users see a baffling number.

v1.19.10 fixed one round (cleaned up the "IR-041" string), but IR-036 / IR-037 were not fully cleaned. This proposal fixes it thoroughly.

## In scope

- New `shared/lint-event-types.js` defining two neutral event constants
- Change the rule field in the `shared/language-lint.js` violation list to use the constants
- Change `hooks/ownmind-reply-lint.js` message rendering to be neutral (remove the IR-XXX number)
- Change `hooks/lib/build-compliance-events.js` to map events to personal iron-rule numbers via rule metadata
- Change `hooks/lib/lint-event-logger.js` to use the event constants
- Clean the `shared/bug-fingerprints.js:106` description
- Update tests for the new constants
- Add a `triggered_by_event` field to the metadata of Vin's personal iron rules IR-036 / IR-037 (for compliance mapping, does not affect other users)

## Out of scope

- ❌ Leaks of other personal iron-rule numbers (e.g. IR-008 / IR-025 appearing in message templates): handle separately, leave as backlog
- ❌ Renaming the rules themselves from IR-036 numbers to neutral names: rule numbers are Vin's personal memory structure, leave untouched

## Design highlights

### Neutral event constant naming

Use two constants:
- `lint_jargon_explanation_required` (jargon without a plain explanation)
- `lint_language_mixed_ratio` (Chinese-English mix ratio too high)

Snake_case (lowercase + underscores), consistent with the existing naming style in bug-fingerprints.js.

### "Event → personal iron-rule number" mapping

`buildComplianceEvents` finds the rule with `metadata.triggered_by_event === eventName` from the rule cache and uses its `code` as the rule_code. If not found → empty rule_code + use the event's Chinese name as rule_title.

Add metadata to Vin's personal iron rules IR-036 / IR-037:
```json
{
  "triggered_by_event": "lint_jargon_explanation_required"   // IR-036
  "triggered_by_event": "lint_language_mixed_ratio"          // IR-037
}
```

Other users do not set this, no impact (the compliance record writes the event's Chinese name, and the user dashboard can still query it).

### Message rendering

Old: `⚠️  IR-036: 行話 / 專有名詞沒附白話說明 — ...`
New: `⚠️  行話品質：行話 / 專有名詞沒附白話說明 — ...`

Completely removes the "IR-036" phrase. The AI's rewrite annotation only sees the neutral name and won't reference the personal number.

## Version decision

v1.20.4, continuing the v1.20.3 series. This is "fixing an old design flaw", not a new feature, so a patch version is used.

## Risks

- **Large test changes**: 39 occurrences of `'IR-036'` / `'IR-037'` string references need to be changed to the new constants. Getting it wrong easily turns tests red.
- **Compliance record field change**: rule_code may become empty (user did not set triggered_by_event), affecting existing dashboard queries. But Vin will add the metadata himself, and other users have not installed the dashboard mechanism, so the impact is controllable.
- **Local hook sync**: need to cp 5+ files and restart Claude Code for it to fully take effect.
