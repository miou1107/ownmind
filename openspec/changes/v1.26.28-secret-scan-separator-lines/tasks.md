# Tasks — v1.26.28 secret scan separator-line false positive + actionable block message

## Phase 1: Root cause (done)

- [x] Pull bug-report id=6 from the server API; reproduce against repo HEAD —
      the quoted lines do NOT match. Replayed the detector over all 39,031
      added lines of the blocked funpass commit (ef2ab40): only hits are
      punctuation-only separator lines via heuristic:long_alnum.
- [x] Identify the secondary defect: block message omits matched_text, which
      caused the misdiagnosis in the report.

## Phase 2: TDD fix (done)

- [x] Write 8 unit cases (secret-detect-unit.test.js) + 3 hook cases
      (pre-commit-secret.test.js). Verify RED first (7 initial + 1 masking
      case; 3 guards already green).
- [x] Add PUNCTUATION_ONLY_REGEX negative condition to the length heuristic.
- [x] Append matched="…" to the pre-commit block message. Verify GREEN.
- [x] Full suite 2041 pass / 0 fail.
- [x] Real-world replay: 39,031 lines of the blocked commit → 0 hits.

## Phase 3: Quality gates (done)

- [x] verification-before-completion — evidence: red-green replay (revert →
      7 fail, restore → pass) + full suite output + funpass replay.
- [x] requesting-code-review — verdict "with fixes": 1 Important (regex hits
      echoed real keys in full next to the report call-to-action), 4 Minor.
- [x] receiving-code-review — Important fixed via maskSecretFragment
      (regex:* masked head8…tail4, heuristic:* full, TDD red→green). Minor:
      stale JSDoc fixed, LONG_ALNUM↔PUNCTUATION_ONLY lockstep note added,
      proposal test-count reworded; truncation-test suggestion superseded by
      the masking test.

## Phase 4: Release

- [ ] package.json 1.26.27 → 1.26.28; CHANGELOG entry; FILELIST check; tag v1.26.28.
- [ ] Mark bug-report id=6 fixed (and id=4, already fixed by v1.26.8) via API.
