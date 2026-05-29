# v1.20.2 — Task list

## High-level phases

1. **Write reproduction test** (IR-003)
   - `tests/verification.test.js` add new describe block: `FIX_HINTS.recent_event_exists`
   - At least 3 cases:
     - verification missing → hint contains full call example
     - code-review missing → hint contains full call example
     - hint not triggered when passing
   - Make the test red first
2. **Change FIX_HINT**
   - `shared/verification.js`: change `FIX_HINTS.recent_event_exists` to return a string containing `ownmind_report_compliance({rule_title: '<event>', action: 'comply'})` plus a "do not pass rule_code" hint
   - Make the reproduction test green
3. **Run full test suite to confirm no regression**
   - `node --test tests/verification.test.js`
   - `npm test` (full suite)
4. **Bump version**
   - `package.json`: 1.20.1 → 1.20.2
   - Find the SERVER_VERSION sync point (src/server-version.js or similar)
5. **Update CHANGELOG**
   - `CHANGELOG.md` add v1.20.2 entry at the top
6. **Update FILELIST**
   - `FILELIST.md` add new proposal folder path
7. **README tri-language check**
   - `README.md` / `README.en.md` / `README.ja.md` grep "verification" / "code-review" / "recent_event_exists"; update wherever mentioned
8. **Quality control three steps**
   - `superpowers:verification-before-completion` → `ownmind_report_compliance({rule_title: 'verification', action: 'comply'})`
   - `superpowers:requesting-code-review` → `ownmind_report_compliance({rule_title: 'code-review', action: 'comply'})`
   - `superpowers:receiving-code-review` to handle review feedback
9. **commit + push**
   - Expect the local hook to allow it through
