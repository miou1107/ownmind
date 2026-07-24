# v1.26.30 — Validate bug-report status_reason before the DB write

## One-Line Summary

`PATCH /api/bug-reports/:id/status` never validates `status_reason` against
the enum the DB CHECK constraint enforces, so an out-of-enum value falls
through to a bare `500 "Failed to update status"` — the caller cannot tell a
constraint violation from a real server fault.

## Why

Vin hit this on 2026-07-07 while closing bug report #5: a hand-written
`status_reason` string violated the `bug_reports_status_reason_check`
constraint, and the endpoint returned a generic 500 with no hint about the
allowed values. Same failure mode the `iron_rule` lint had (bug #5) — the
server knew exactly what was wrong but surfaced an unactionable error. This
mirrors the v1.26.16 fix philosophy: turn opaque failures into actionable
400s.

## Current State

- The DB constraint (`db/016`, `db/017`) allows `status_reason` to be NULL or
  one of: `by_design`, `duplicate`, `low_priority`, `cannot_reproduce`,
  `wontfix_other`.
- The route validates `status` against its own enum, requires `status_reason`
  when `status=wontfix`, and requires a note when
  `status_reason=wontfix_other` — but never checks that `status_reason`
  itself is a member of the allowed set.
- An unknown `status_reason` therefore reaches the UPDATE, trips the CHECK
  constraint, throws, and is caught into `500 Failed to update status`.

## Fix

`src/routes/bug-reports.js` `PATCH /:id/status` — add an enum guard after the
existing `status` validation and before the UPDATE:

- If `status_reason` is provided (non-empty) and not in the allowed set,
  return `400` with a message listing the valid values.
- Keep NULL / omitted `status_reason` valid (the column is nullable).

Single source of truth: define the allowed list as a constant so it cannot
drift from the DB constraint silently.

## Out of Scope

- Changing the set of allowed `status_reason` values.
- Any other endpoint (this is the only one that writes `status_reason`).

## Verification

- New source-level test in `tests/bug-report-status-reason.test.js`
  (route needs a live DB, so following the `memory-title-update.test.js`
  precedent): assert the PATCH handler declares the allowed-value list and
  rejects an out-of-enum `status_reason` with a 400 before the UPDATE.
- Verified RED first (guard stashed → fail), then GREEN.
- Full suite green.
- Live check after deploy: PATCH with a bogus status_reason → 400 listing
  allowed values (not 500).
