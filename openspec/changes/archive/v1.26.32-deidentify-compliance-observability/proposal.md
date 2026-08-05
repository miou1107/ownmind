# v1.26.32 — De-identify the iron-rule compliance observability loop (drop hardcoded personal rule code)

## One-Line Summary

The server-side "modifying an iron rule should be observed" compliance loop
hardcodes one specific user's personal iron-rule code (`IR-006`) and that
user's verbatim rule title on both the emit side (`activity.js`,
`mcp/index.js`) and the expect side (`me.js`). For every other OwnMind user,
rule #6 is something different, so the emitted compliance data and the
cross-user pitfalls view are labelled with a rule that does not belong to
them.

## Why

- Violates the product's own long-standing constraint (already documented in
  `shared/lint-event-types.js`): personal iron-rule codes must never appear
  in product code.
- Multi-user pollution: the `/api/me/pitfalls` view is cross-user (visible to
  anyone) and prints `expected_rules = ['IR-006']` next to every user's
  rule-mutation events, asserting a rule they may not have.
- The neutral-event pattern that fixes this already exists and is proven in
  production — `shared/lint-event-types.js` + `metadata.triggered_by_event`,
  shipped in v1.19.10 (`privacy_check`) and v1.20.4 (reply-lint neutral
  events). This change extends that same pattern to the last remaining
  hardcoded compliance loop.

## Current State

The loop is a closed, self-consistent pair, both sides hardcoding `IR-006`:

- **Emit** — when a user saves / disables / updates an iron rule, the server
  auto-writes an `iron_rule_compliance` activity row:
  - `src/routes/activity.js` `autoEmitObservedTrigger` (3 branches): sets
    `rule_code: 'IR-006'`, `rule_title: '學到東西必須全層同步更新'`.
  - `mcp/index.js` (2 spots, ~1375 / 1386): same hardcoded pair.
- **Expect** — `src/routes/me.js`:
  - `complianceGapQ` (~536): `expected_rules = ARRAY['IR-006']`, and the
    match predicate (~560) functionally compares
    `c.details->>'rule_code' = ANY(s.expected_rules)`.
  - pitfalls `unobservedQ` / `unverifiedQ` (~893 / 941):
    `expected_rules = ARRAY['IR-006']` — here the value is only SELECTed and
    returned for cross-user display (the WHERE match does not use it), so this
    is the visible cross-user leak.

The frontend "鐵律遵守率 (iron-rule compliance rate)" column is a **separate**
mechanism driven by `session_logs.details.rules_complied[]` via
`usage/team-overview.js`; it does not touch `IR-006` and is out of scope.

Historical production rows already carry `rule_code = 'IR-006'`; a destructive
data migration is explicitly out of scope, so the expect side must stay
backward-compatible with them.

## Fix

Extend the existing neutral-event pattern (`shared/lint-event-types.js`).

1. **New neutral event constant** `rule_full_layer_sync` (display name
   "Full-layer sync on rule change") registered in
   `shared/lint-event-types.js`. This replaces the meaning previously carried
   by the hardcoded `IR-006`.
2. **Emit side** (`activity.js`, `mcp/index.js`): stop writing a personal
   rule code / verbatim personal title. Write
   `triggered_by_event: 'rule_full_layer_sync'`, a neutral `rule_title`
   (the event display name), and leave `rule_code` empty — mirroring
   `buildComplianceEvents` (v1.20.4), which resolves the personal code from
   the user's own rule cache and leaves it empty when unresolved.
3. **Expect side** (`me.js`):
   - `expected_rules` CASE arms → the neutral event constant.
   - `complianceGapQ` match predicate → match on
     `details->>'triggered_by_event'` **or** legacy `details->>'rule_code' =
     'IR-006'` (backward-compat shim for historical rows, documented as such).
   - pitfalls queries → neutral `expected_rules` value (removes the cross-user
     display leak); no match-logic change needed there.

## What Changes

- `shared/lint-event-types.js` — add the `rule_full_layer_sync` constant,
  display name, and enumeration entry.
- `src/routes/activity.js` — neutralize `autoEmitObservedTrigger` (3 branches)
  + persist `triggered_by_event` in the compliance INSERT; export the function
  for unit testing.
- `mcp/index.js` — neutralize the 2 emit spots.
- `src/routes/me.js` — neutralize `expected_rules` in all 3 queries; update
  `complianceGapQ` match predicate to be event-based + legacy-compatible.
- Tests — new reproduction tests asserting no `^IR-\d+$` personal code is
  emitted and that `me.js` matches on the neutral event.

## Emit sites (all four neutralized)

The compliance row is written from four places; all must be de-identified
together or the loop splits into two labels:

- `src/routes/activity.js` `autoEmitObservedTrigger` — client-batch path.
- `mcp/index.js` `autoComplyForToolCall` — MCP client path.
- `src/routes/memory.js` (save + disable) — the v1.17.87 server-side backfill
  that writes immediately (the client batch can drop the event). **This is the
  authoritative path for most users and was the easiest to miss.**

## Known Limitation (not introduced here)

The `complianceGapQ` / `unverifiedQ` "unverified" check looks for a **manual**
comply row (non-`system_*` source) matching the expected event. The manual
comply path (`ownmind_report_compliance`) writes only `rule_code`, never
`triggered_by_event`, so the go-forward `triggered_by_event` branch is
currently **dead** for real comply rows: gap **detection** functions only via
the legacy `rule_code = 'IR-006'` shim — i.e. it works only for the one user
whose personal code is literally `IR-006`, and is **non-functional for every
other user today**. This was already the case before this change (the
predicate was `rule_code = ANY(['IR-006'])`), so it is not a regression, but it
is also not fixed here — this change de-identifies the emitted data and the
cross-user **display** labelling only, not gap detection.

Two things the follow-up must do (wiring `ownmind_report_compliance` to resolve
and emit the neutral event via `findUserRuleByEvent`):
1. Make the `triggered_by_event` branch live so gap detection works for all
   users, not just IR-006.
2. Retire the `LEGACY_FULL_LAYER_SYNC_CODE = 'IR-006'` shim — it can
   false-clear a gap for a non-Vin user whose unrelated rule #6 happens to have
   an IR-006 comply in the ±10-minute window (mirror of the original bug,
   bounded to historical pre-v1.26.32 rows only).

## Non-Goals

- No change to the frontend compliance-rate column (separate, already clean).
- No destructive data migration of historical `IR-006` compliance rows.
- No per-user dynamic rule resolution on the server (kept empty, resolved by
  cache-holding callers per the established v1.20.4 pattern).
- No fix to multi-user gap *detection* (see Known Limitation) — follow-up.
