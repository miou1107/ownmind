# Tasks — v1.26.33 De-identify pre-commit secret-guard

## Phase 1: RED

- [x] Add `tests/secret-guard-rule.test.js` (helper unit test).
- [x] Add integration case to `tests/pre-commit-secret.test.js` (non-IR-002
      code + secret in content → block). Confirmed FAILS pre-fix (secret slips).
- [x] Run both, confirm RED for the expected reasons.

## Phase 2: GREEN

- [x] `hooks/lib/secret-guard-rule.js` — `isSecretGuardRule(verification)`.
- [x] `hooks/ownmind-git-pre-commit.js` — gate content scan on the helper; add
      `isSecretRule` to blockReasons.
- [x] `hooks/lib/select-block-fingerprint.js` — secret category via
      `isSecretRule || secretHit`; drop `SECRET_RULE_CODES`.
- [x] Update `tests/git-pre-commit-fingerprint.test.js` secret cases to the
      `isSecretRule` flag; add a non-IR-002 secret case.
- [x] Run new + updated tests, confirm GREEN.

## Phase 3: Verify

- [x] Full `npm test` green (2064 pass / 0 fail; lint:zh-only + node --test).
- [x] Grep: no `IR-002` left in the pre-commit secret path or the secret
      fingerprint category (only deferred quality codes remain).
- [x] verification-before-completion + requesting-code-review (ready to
      proceed, no Critical/Important) + receiving-code-review (helper edge-case
      note applied).

## Phase 4: Release (batched)

- [x] package.json 1.26.32 → 1.26.33; CHANGELOG; FILELIST; trilingual README.
- [ ] Single tag v1.26.33 + deploy for v1.26.32+33 together — await Vin's go.
      **Deploy-time live check (per code review): one real commit with a fake
      key on a non-IR-002 secret rule to confirm the content scan fires.**
