# v1.19.13 — task list

## Phase 0: alignment (done)

- [x] T0.1 Clarify the root cause (value-side keyword containing the word password matched)
- [x] T0.2 Vin decides the fix direction (only change the keyword logic, go for the root-cause fix)
- [x] T0.3 Write proposal.md / spec.md / tasks.md

## Phase 1: red (TDD red)

- [ ] T1.1 Add new tests to `tests/secret-detect-unit.test.js`
  - S1.1～S1.9 (the new value-side keyword logic)
  - S2.1～S2.4 (matched_text)
  - S5.1～S5.5 (existing-behavior regression check, should pass automatically)
- [ ] T1.2 Add new tests to `tests/memory-secret-guard.test.js`
  - S3.1～S3.2 (400 response contains matched_text)
  - S4.1 (full bot.example.com case regression)
- [ ] T1.3 `node --test tests/secret-detect-unit.test.js tests/memory-secret-guard.test.js`, confirm the new tests are red and the old tests are still green

## Phase 2: implementation (TDD green)

- [ ] T2.1 Change `shared/secret-detect.js`
  - Add the `KEYWORD_ASSIGNMENT_REGEX` constant
  - Change the value-side keyword section from the `includes()` loop to a regex match
  - All three match types (regex/keyword/heuristic) return `matched_text` (truncated to 80 chars)
  - Update the JSDoc: explain the v1.19.13 change and why it's written this way
- [ ] T2.2 Change `src/utils/memory-secret-guard.js`
  - Add `matched_text: detection.matched_text` to the 400 body
- [ ] T2.3 Run all tests until everything is green

## Phase 3: manual verification (verification-before-completion)

- [ ] T3.1 Bring up a local server, try saving the bot.example.com content via curl or the admin UI, confirm success
- [ ] T3.2 Use curl to try saving "password: MyP@ssw0rd123", confirm it's blocked and the 400 body contains matched_text
- [ ] T3.3 grep all `detectSecretLike` call sites, confirm no caller assumes the old return format (without matched_text)

## Phase 4: sync docs + version (IR-008 / IR-026 / IR-031 / IR-032)

- [ ] T4.1 `package.json` version: 1.19.12 → 1.19.13
- [ ] T4.2 `CHANGELOG.md` add v1.19.13 entry
- [ ] T4.3 `README.md` add v1.19.13 change description
- [ ] T4.4 `docs/README.zh-TW.md` add the corresponding section
- [ ] T4.5 `docs/README.ja.md` add the corresponding section
- [ ] T4.6 `FILELIST.md`: unchanged (no new files) — still git diff to confirm

## Phase 5: Code review + commit (IR-045)

- [ ] T5.1 Run the superpowers:requesting-code-review skill
- [ ] T5.2 Handle review feedback
- [ ] T5.3 commit (IR-009 / IR-024: author Vin, no Co-Authored-By)
- [ ] T5.4 `git tag v1.19.13`
- [ ] T5.5 `git push origin main && git push --tags`
- [ ] T5.6 Sync update to project 469 (mark done) + write a session_log recording this incident and fix

## Phase 6: archive (after release)

- [ ] T6.1 `git mv openspec/changes/v1.19.13-secret-detect-keyword-tighten openspec/changes/archive/`
- [ ] T6.2 Deploy prod? (Vin's call)

---

## Not for now (noted)

- The pre-commit hook's `checkStagedDiffForSecrets` uses `skip_keyword: true`, so this logic change has no effect on it. If the hook later wants the new keyword logic (only block on assignment pattern), open a new proposal then.
- The UX design for showing matched_text in the Admin UI (let the API return it first, decide later whether the UI shows it).
