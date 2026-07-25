# Tasks — v1.26.35 De-identify names in generated output

## Phase 1: RED
- [x] Add `tests/no-hardcoded-names-in-output.test.js` — behavioral assertions
      on buildBigSkillMd / buildReferenceFile / suggestSkillMdFormat /
      buildMessages + client App.jsx default profile. Confirmed RED (all leak).

## Phase 2: GREEN
- [x] iron-rule-sync.js — "Vin" → generic second-person (3 spots).
- [x] iron-rule-suggest.js — generated description → "是你...".
- [x] llm-narrative.js — prompt example "Vin" → "Alice".
- [x] client/src/App.jsx — default profile name → "User".
- [x] Update `tests/iron-rule-sync.test.js` assertion to the new text.
- [x] Name test + full suite green (2069 pass / 0 fail).

## Phase 3: Verify
- [x] verification-before-completion + requesting-code-review (ready to
      proceed; confirmed App.jsx was a real TopBar leak, no other user-facing
      leak missed) + receiving-code-review.

## Phase 4: Release (batched)
- [x] package.json 1.26.34 → 1.26.35; CHANGELOG; FILELIST; trilingual README.
- [ ] Single tag v1.26.35 + deploy for v1.26.32-35 together — await Vin's go.
      Deploy must rebuild the dashboard (vite build) so the top bar drops "Vin".
