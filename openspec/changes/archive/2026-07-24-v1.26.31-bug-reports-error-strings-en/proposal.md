# v1.26.31 — Translate bug-reports.js error strings to English

## One-Line Summary

`src/routes/bug-reports.js` still returns Chinese permission errors
(`需要管理員權限`, `權限不足`). Per CLAUDE.md 軌道 B (developer-facing English:
server error messages are English), translate them in a single consistent
pass. Scoped to this one file — deferred from v1.26.30 to avoid a partial,
inconsistent drive-by edit.

## Why

The developer-facing internationalization track requires server error
messages to be English so global contributors can read them. New strings in
this file (v1.26.30's `status_reason` guard, all the `POST` validation
errors) are already English; the permission checks are the last Chinese
holdouts, which reads inconsistently within the same handlers.

## Current State

- 7 Chinese error literals across the route handlers:
  - `'需要管理員權限'` — 5 admin-permission checks
    (notifications, spam-suspects list, confirm, dismiss, PATCH status).
  - `'權限不足'` — 2 checks (GET list `scope=all`, GET `/:id` non-owner).
- Verified no consumer matches on these strings: `client/src`, `src/public`,
  and the whole repo have no equality/regex check against them, and there is
  no route-level test asserting bug-reports.js response bodies. So the change
  is behavior-safe.

## Fix

- `需要管理員權限` → `Admin permission required`
- `權限不足` → `Insufficient permission`

Leave the other CJK in the file untouched (out of scope, intentional):
- The `confirm_string="送出"` comment references the literal confirm token
  clients actually send — that is product/user data, not a dev message.
- The `/1MB|超過|exceeds/` regex deliberately matches legacy Chinese output
  from `validateContextBlob` for backward compatibility.

## Out of Scope

- The same `需要管理員權限` string in `src/middleware/adminAuth.js` and in
  test mocks (`broadcast`, `clients`, `team-stats`). Those belong to a
  planned repo-wide translation pass, not this single-file tidy-up.
- Any behavior change.

## Verification

- Full suite green (string-only change; no test asserts these bodies, so the
  suite stays green and proves no regression).
- Live check after deploy: an admin-only endpoint hit as a non-admin returns
  the English message.
