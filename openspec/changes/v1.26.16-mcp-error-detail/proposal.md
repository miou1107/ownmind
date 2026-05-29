# v1.26.16 — MCP client surfaces structured API error detail

## One-Line Summary

Fix a user-reported bug: saving a `type=iron_rule` that fails the quality check
returned HTTP 400 with a generic "please fix the following issues" message but
never showed WHICH issues. The server returned the detail; the MCP client's
generic error handler discarded it.

## Bug Report

- `ownmind_save({type:"iron_rule", ...})` → 400 "Iron rule quality check failed —
  please fix the following issues and try again", with NO list of the issues.
  Tried 5 rewrites, all blocked, no actionable feedback.
- Same content as `type=principle` saved fine (it does not run the iron-rule lint).
- Reporter's note: unsure if (a) API never returned detail or (b) MCP client
  truncated it. Confirmed via code: (b).

## Root Cause

- Server (`src/routes/memory.js` L946-953, and the PUT path L1248-1254) returns a
  structured body: `{ error, errors: [...specific lint failures], hint }`.
- MCP client `callApi` (`mcp/index.js`) built the thrown message as
  `data.error || data.message || JSON.stringify(data)` — surfacing only the
  generic `error`, discarding `errors[]` and `hint`. This is the GENERIC error
  path, so every structured API error lost its detail, not just iron_rule.

## Fix

- New `mcp/lib/api-error-message.js` — pure function `buildApiErrorMessage(data, text)`
  that composes `error`/`message` (kept first) + each `errors[]` item + `hint`.
- `callApi` uses it in the `!res.ok` branch.

## Out of Scope

- The `sync_token` stale-409 auto-retry not firing (server stale message lacks the
  "sync_token" substring) — a pre-existing, unrelated bug found during review,
  filed as a separate task.

## Verification

- New `tests/api-error-message.test.js` (6 cases): reproduction (errors[] + hint
  surfaced), sync_token-retry-substring retention, message fallback, non-object,
  empty object, non-array errors guard.
- TDD: test written first, verified RED (module missing), then GREEN.
- Full suite 2009 pass / 0 fail / 0 skipped. The 17 sync_token retry tests stay green
  (the top-level `error` is kept first, so `/sync_token/i` matching is unaffected).
