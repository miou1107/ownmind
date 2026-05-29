# v1.19.3 — Reply-lint Progressive Block task list

> Per IR-003 (TDD): write the test before each implementation task
> Per IR-012 (quality gate three steps): verify → request review → handle feedback
> Per IR-008 (commit syncs README/FILELIST/CHANGELOG)

---

## Phase A: language-lint.js expand whitelist + threshold + proper noun + window

- [ ] A1. Write tests (scenarios 9 / 10 / 11 / 12 / 13)
  - The Top 30 violation words no longer trigger once all in the whitelist
  - Proper noun pattern is skipped
  - With code block → threshold 25%
  - With code review → fully exempt
  - IR-036 window 80 chars
- [ ] A2. Change `shared/language-lint.js`
  - `TECH_WHITELIST` expanded from 80 words to 200+ (annotated in 5 categories)
  - `checkMixedLanguage(content, options)`: detect code block / code review, dynamic threshold
  - `looksLikeProperNoun(word)` pure function
  - `checkJargonExplanation`: window 50→80

---

## Phase B: Session counter pure functions

- [ ] B1. Write tests `tests/session-counter.test.js` (scenarios 7 / 8 / 14)
  - File doesn't exist → treat as 0
  - File corrupted → treat as 0, overwrite
  - Auto-clean entries older than 30 days
  - increment / read / write
- [ ] B2. New file `hooks/lib/session-counter.js`
  - `readCounter(sessionId)`
  - `incrementCounter(sessionId)`
  - `cleanupStale(maxAgeMs)`

---

## Phase C: Hook integration MODE + progressive block

- [ ] C1. Write tests `tests/reply-lint-hook.test.js`, add new cases (scenarios 1 ~ 6 + 15)
  - Change the existing 14+ status===0 assertions: branch by MODE
  - MODE=warn behavior unchanged
  - MODE=block 1st/2nd/3rd time don't block, 4th block JSON
  - MODE=block stop_hook_active=true doesn't increment count
  - MODE=disable fully skips
  - MODE unknown value falls back to warn
  - reason is instruction-style, contains specific words, contains rewrite example
- [ ] C2. Change `hooks/ownmind-reply-lint.js`
  - Add reading the `OWNMIND_REPLY_LINT_MODE` env
  - On violation call `incrementCounter` to get the new count
  - Count < 4: original banner + spool + POST + exit 0
  - Count ≥ 4 && MODE=block: write stdout block JSON + banner (with ⚠️ marker) + spool + POST + exit 0
  - Add `formatBlockReason(violations)` instruction-style format
  - Banner gets one more line "current session N violations, accumulating 4 will block"

---

## Phase D: end-to-end verification

- [ ] D1. Locally install the new hook, open a Claude session, manually reply with an obvious violation, observe the banner behavior
- [ ] D2. Switch `OWNMIND_REPLY_LINT_MODE=block`, violate 4 times in a row, live-test that block JSON triggers + Claude rewrites after receiving the reason
- [ ] D3. Confirm the stop_hook_active safeguard works (doesn't run 8 consecutive blocks before stopping)
- [ ] D4. Run npm test, the full suite, confirm existing cases + new cases all green

---

## Phase E: docs sync (IR-008 + IR-026 + IR-032)

- [ ] E1. `README.md` Reply Lint section: add MODE explanation + progressive block flow
- [ ] E2. `docs/README.zh-TW.md`, `docs/README.ja.md` synced
- [ ] E3. `CHANGELOG.md` add v1.19.3 entry
- [ ] E4. `FILELIST.md` add session-counter.js + new test file

---

## Phase F: version number + commit + tag + push (client-side, no server deploy)

- [ ] F1. `package.json` v1.19.3 (SERVER_VERSION read dynamically, no change needed)
- [ ] F2. Quality gate three steps (IR-012): verification → request review → handle review
- [ ] F3. Commit (IR-009 Vin contributor + IR-024 no Co-Authored-By)
- [ ] F4. Tag v1.19.3 + push origin main + tag

---

## Phase G: run 1 week of audit + decide whether to flip block to default

- [ ] G1. Locally update OwnMind to v1.19.3, keep `MODE=warn` default (don't change env)
- [ ] G2. Run for 1 week, record the change in violation counts (should drop sharply after the whitelist expansion)
- [ ] G3. Evaluate whether to: a) flip block to default, b) shrink the whitelist further, c) keep as-is
- [ ] G4. (later version) archive the openspec change folder
