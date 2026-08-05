# Tasks — v1.26.34 Guard against personal iron-rule codes

## Phase 1: RED (guard)

- [x] Add `tests/no-personal-rule-codes.test.js` scanning product dirs for
      `IR-\d{2,4}` (case-insensitive), allowlisting only the me.js legacy shim.
- [x] Run it — confirmed RED with all ~80 violations listed.

## Phase 2: GREEN (clean)

- [x] Comments / help text / schema descriptions across 28 files → describe the
      rule's purpose, drop the number; generic examples → `IR-XXX`.
- [x] `hooks/lib/select-block-fingerprint.js` — remove personal-code quality
      category; update `tests/git-pre-commit-fingerprint.test.js`.
- [x] `hooks/ownmind-git-commit-msg` — neutralize label + "Vin 的鐵律";
      update `tests/git-hook-co-authored-by.test.js`.
- [x] Guard green; full `npm test` green (2064 pass / 0 fail).

## Phase 3: Verify

- [x] verification-before-completion (guard + suite green; diff sanity-checked:
      only comments/strings changed except the intended fingerprint removal).
- [x] requesting-code-review (ready to proceed; minor notes applied: hardened
      guard bare-script + regex coverage, cleaned placeholder-y tip text).
- [x] receiving-code-review (name-leak follow-up spawned as a separate task).

## Phase 4: Release (batched)

- [x] package.json 1.26.33 → 1.26.34; CHANGELOG; FILELIST; trilingual README.
- [ ] Single tag v1.26.34 + deploy for v1.26.32+33+34 together — await Vin's go.
