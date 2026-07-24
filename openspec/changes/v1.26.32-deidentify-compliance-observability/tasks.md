# Tasks — v1.26.32 De-identify compliance observability

## Phase 1: RED (reproduction tests first, per TDD)

- [x] Add `tests/deidentify-compliance-observability.test.js` (6 cases:
      emit behavior + source assertions across all four emit sites + me.js).
- [x] Run the new test file, confirm it FAILS for the expected reasons.

## Phase 2: GREEN (implement)

- [x] `shared/lint-event-types.js` — add `RULE_FULL_LAYER_SYNC`, display name,
      `ALL_LINT_EVENTS` entry.
- [x] `src/routes/activity.js` — neutralize `autoEmitObservedTrigger` (3
      branches); persist `triggered_by_event` in the INSERT; export the fn.
- [x] `mcp/index.js` — neutralize the 2 emit spots (+ dedup/logEvent/append).
- [x] `src/routes/memory.js` — neutralize the v1.17.87 backfill emit (save +
      disable). **Added after code review found this third emit path.**
- [x] `src/routes/me.js` — neutralize `expected_rules` in complianceGapQ +
      both pitfalls queries; update BOTH functional match predicates
      (complianceGapQ + unverifiedQ) to event-based + legacy `IR-006` compat.
- [x] Run the new test file, confirm it PASSES.

## Phase 3: Verify

- [x] Full `npm test` green (2058 pass / 0 fail; lint:zh-only + node --test).
- [x] Grep confirms all four emit sites free of `IR-006`; me.js only retains
      it as the documented `LEGACY_FULL_LAYER_SYNC_CODE` shim.
- [x] verification-before-completion + requesting-code-review (2 criticals
      found + fixed) + receiving-code-review (re-review in progress).

## Phase 4: Release

- [x] package.json 1.26.31 → 1.26.32; CHANGELOG; FILELIST; trilingual README
      version lines; commit; tag.
- [ ] Await Vin's go for push + deploy; then deploy + live verify.
