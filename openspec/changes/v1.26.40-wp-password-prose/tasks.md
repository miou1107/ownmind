# v1.26.40 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Root cause (systematic debugging, before any fix)

- [x] Reproduce: the reported sentence matches the rule's shape exactly
- [x] Check history: v1.19.1 (`ad0104d`) already tightened `{5,}` → `{5}` to
      curb this, so a second attempt at the same lever is not the answer
- [x] Compare against the working rules: every other regex carries an
      identifying prefix; this one matches on shape alone
- [x] Confirm the generator from official sources: `wp_generate_password(24,
      false)` → 24 chars of upper / lower / digits, shown in six groups
- [x] Note the pattern: bugs #4, #6, #8 are all shape-based false positives in
      this same component

## Phase 1 — Choose the discriminator by measurement, not intuition

- [x] Score four candidates against 500,000 generated passwords and a prose
      corpus (repo docs plus the reported sentence in several casings)
- [x] Reject "at least one digit": misses 1.4955% of real passwords
- [x] Reject mixed-case and the group-level variant: each leaves one prose
      casing flagged
- [x] Select "at least one group not word-shaped": 0 misses, 0 false positives

## Phase 2 — RED tests

- [x] Create `tests/secret-detect-wp-prose.test.js`
- [x] Real passwords still detected, including embedded in text
- [x] 2,000 generated passwords all detected
- [x] Five prose shapes cleared
- [x] Prose must not shadow a credential; `matched_text` names the credential
- [x] Other regex rules untouched
- [x] Run and confirm 7 of 14 fail for the right reason

## Phase 3 — Implementation

- [x] Add `looksLikePlainWord(token)`
- [x] Add `confirm` to the WP rule
- [x] Add `findConfirmedMatch` and scan every match, not just the first
- [x] New tests green (14), full suite green (2149)

## Phase 4 — Verify against the real code path

- [x] Confirm the hook feeds the detector line by line with `skip_keyword`
      (`hooks/ownmind-git-pre-commit.js:137-139`)
- [x] Replay the reported data through that exact call shape, before and after:
      prose blocked → cleared, real password blocked → still blocked
- [x] Note the sharper result: before the fix the scanner reported the *prose*
      as the secret on a line that also held a real password, masking it
- [x] Attempted a full hook run in a scratch repo; it no-ops without the local
      iron-rule cache, so that attempt proved nothing and was not counted

## Phase 5 — Docs and version

- [x] `CHANGELOG.md` — v1.26.40 entry
- [x] `FILELIST.md` — register the new test and changed file
- [x] `README.md` — grepped all three languages; they describe secret routing
      as a feature, not this rule, so no sync needed
- [x] Bump `package.json` to 1.26.40

## Phase 6 — Quality gates (mandatory)

- [x] `superpowers:verification-before-completion`
- [x] `superpowers:requesting-code-review` — 2 Critical, 4 Important, 4 Minor
- [x] `superpowers:receiving-code-review` — every finding reproduced against the
      shipped code before acting; see Phase 6b

## Phase 6b — Review fixes

- [x] **Critical: the first implementation introduced false negatives.**
      `matchAll` advances past a match's end, carving a contiguous token run
      into fixed six-token windows. A credential straddling a boundary was
      never evaluated: measured 8.98% miss with five leading prose words. Now
      resumes one character past a rejected match's start; re-measured 0.000%
      across 0-7 leading words × 20,000 draws each
- [x] Critical: both shadowing tests passed against the broken scanner because
      each fixture had a separator breaking the token run. Added a
      parameterized case with 1-7 leading words and no separator
- [x] Important: the "0.00000% miss" claim was false. True rate is
      `(3·(26/62)^4)^6 = 6.378e-7`; 500k draws had no power to see it.
      Corrected in proposal, CHANGELOG, and the rule comment, with the residual
      case pinned by its own test
- [x] Important: the generated-password test was live-random, so it would have
      failed about 1 run in 784 against a correct implementation. Now seeded
- [x] Important: CHANGELOG repeated the #6 reporter's hypothesis as fact.
      v1.26.28 disproved it — the real cause was punctuation-only separator
      lines caught by the length heuristic. Corrected in both documents
- [x] Important: Phase 5 checkboxes brought up to date (this block)
- [x] Minor: moved the orphaned `truncateMatch` JSDoc back to its function
- [x] Minor: documented `looksLikePlainWord`'s contract (4-char ASCII alnum)
      and why every out-of-contract input fails safe
- [x] Minor: tightened `matched_text` to exact equality where the credential is
      unambiguous; where prose runs straight into it, assert the fragment
      carries the group that proves it is not prose, and record in the spec why
      exact equality is not achievable there
- [x] Filed the strategy review as a real backlog item (OwnMind project memory
      731) rather than leaving it as a paragraph that gets archived
- [x] Sharpened the "what this does not solve" framing: #4 and #6 came from the
      length heuristic, which has accumulated three negative-condition escape
      hatches — a different code path from the one this change touches

## Phase 7 — Release

- [ ] Commit (no Co-Authored-By)
- [ ] Tag `v1.26.40`, push, deploy to kkvin.com
- [ ] Run pending migrations first — expected none
- [ ] Mark bug report #8 fixed
- [ ] Note that the hook runs client-side, so users need the client update too
