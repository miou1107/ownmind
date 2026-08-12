# Tasks — v1.26.149 (issue #92)

## 1. The guard, written first

- [x] `tests/iron-rule-trigger-parity.test.js` — the 18-command table, asserted against
      `detectCommandTrigger()` and against the real `.sh` hook
- [x] Shell side observed by spawning the hook and parsing its banner; no grep patterns
      restated in the test
- [x] Unparseable output throws instead of resolving to `null`
- [x] No `bash is missing` skip — the shell half spawns unconditionally, matching
      `tests/iron-rule-install-trigger.test.js`
- [x] Run before any fix: **7 of 17 failed**, exactly the seven issue #92 predicted

## 2. The fix

- [x] `hooks/ownmind-iron-rule-check.sh` — the chain becomes a transcription of
      `detectCommandTrigger`, in its order
  - [x] `git tag` → commit (was absent)
  - [x] deploy family → `docker compose (up|build|push)`, `docker stack deploy`,
        `kubectl apply`, `npm run deploy` (was `docker.*deploy|docker.*up`)
  - [x] `Remove-Item` → delete (was absent)
  - [x] delete branch moved after deploy, matching the reference's order
  - [x] `del ` dropped — cmd.exe only, and `Remove-Item` covers the same operation
- [x] `shared/helpers.js` — `docker stack deploy` added to the deploy family, the one
      pattern the shell copy had and the reference did not

## 3. The notes that should have existed

- [x] `detectCommandTrigger` carries a `KEEP IN SYNC` note naming the shell copy, saying the
      order matters as well as the patterns, and naming the parity test
- [x] The `TRIGGER_TAG_ALIASES` note now distinguishes what it guards (that table,
      `iron-rule-trigger-aliases.test.js`) from what had nothing guarding it
- [x] The shell chain's header records what changed and why, including the two patterns that
      moved and where a new one belongs

## 4. Verification

- [x] `tests/iron-rule-trigger-parity.test.js` — 36 tests, 0 failures
- [x] Neighbours re-run: `iron-rule-install-trigger`, `iron-rule-trigger-aliases`,
      `iron-rule-fetch-failure-logged`, `iron-rule-hook-payload`, `edit-trigger-reminder`,
      `shebang-eol`, `bash-c-escaping` — 104 tests, 0 failures
- [x] Full suite before the last two edits: 4,743 tests, 2 failures, both in
      `tests/bare-mount-trailing-slash.test.js` and both caused by this checkout having no
      built client (`client/dist` and `client/node_modules` are absent), not by this change
- [ ] Full suite re-run after the `docker stack deploy` addition

## 5. Not done, with reasons

- **The duplication itself.** Issue #92's options A (patterns as shared data) and B (`.sh`
  calls `.js`) both hinge on whether the shell copy still needs to work without node. That
  is a decision, not an implementation detail, and it is worth taking with the parity test
  already in place — either route has to satisfy it.
- **The banner strings.** `.js` English, `.sh` Chinese, and the Chinese one is what mac and
  Linux users see. Issue #91.
- **`del `.** Not carried into the reference. `\bdel\b` matches ordinary text such as a URL
  path segment, and `Remove-Item` — PowerShell's actual name for the operation — is already
  matched, so the cost of leaving it out is small and the false-positive cost of adding it
  is not.
