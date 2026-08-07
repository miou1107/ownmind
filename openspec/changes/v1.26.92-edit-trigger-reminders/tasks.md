# v1.26.92 — Tasks

## Phase 1 — shared logic

- [x] `shared/helpers.js`: `detectToolTrigger(toolName)` → `edit` for Edit / Write /
      MultiEdit / NotebookEdit, `null` otherwise
- [x] `shared/edit-reminder-state.js`: read / write `~/.ownmind/state/edit-reminder.json`,
      env-var override for tests, fail-open on a missing or malformed file
- [x] Pure decision function: given `now` and the stored state, return
      `{ mode: 'full' | 'line', occurrence, windowStartMs }`

## Phase 2 — hooks

- [x] `hooks/ownmind-iron-rule-check.js`: resolve the trigger from `tool_name` when there
      is no command; on `edit`, take the throttle path and skip the verification engine
- [x] `hooks/ownmind-iron-rule-check.sh`: same. The window arithmetic is NOT inlined the way
      the v1.26.91 alias table was — this file already runs `ownmind-verify-trigger.js` by
      absolute path, so the edit path is delegated to `ownmind-edit-reminder.js` the same
      way and exists once. Only the tool-name `case` is duplicated, and a test pins it.
- [x] The throttled path must make no HTTP request — the count comes from the state file

## Phase 3 — installers

- [x] `install.sh`: register the editing-tool matcher, idempotently, leaving the Bash entry
      untouched
- [x] `install.ps1`: same (backlog 28 tracks the wider drift between the two; this change
      must not widen it) — **written, not executed: no PowerShell on the dev machine**

## Phase 4 — tests

- [x] Real payloads through both hook copies against a local HTTP server, as
      `tests/iron-rule-hook-payload.test.js` does: Edit → full list, second Edit → one
      line, expired window → full list again, Read → silence
- [x] The throttled path makes no request (assert against the server's hit log)
- [x] No `decision` key on any edit-trigger output
- [x] The `.sh` inlined tool-name table matches the `shared/helpers.js` export, compared by
      executing the extracted literal, as the alias drift test does
- [x] Installer idempotency: run the registration twice, assert one entry each
- [x] **Break each guard once and confirm it goes red** — throttle window, occurrence
      count, no-network claim, no-block claim

## Phase 5 — docs and release gates

- [x] CHANGELOG, FILELIST, README ×3 (the v1.26.91 sync test pins all three)
- [x] `package.json` → 1.26.92
- [x] `superpowers:verification-before-completion`
- [ ] `superpowers:requesting-code-review`
- [ ] Open the PR. **Do not merge, do not tag, do not deploy** — Vin decides all three
