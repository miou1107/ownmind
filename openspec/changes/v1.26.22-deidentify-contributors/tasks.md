# Tasks — v1.26.22 contributor de-identification

## Safety
- Pseudonym mapping NOT recorded in any committed file.
- Keep `Vin`; rename test fixtures input+assertion in lockstep; docs only otherwise.
- npm test must stay 2012 / 0 / 0.

## Phase 0: Inventory
- [x] Full repo scan for real names (reliable Python scan; grep mis-flagged
      CHANGELOG as binary). Found 7 real people + a client project name across ~50 files.
- [x] Confirm extra names with Vin; agree mapping.

## Phase 1: Scrub
- [x] Apply consistent pseudonyms + internal project names → placeholders repo-wide (49 files),
      excluding the mapping-documentation files.
- [x] Rewrite the 3 mapping-documentation spots (v1.26.21 CHANGELOG entry,
      host-config design doc, v1.26.21 tasks) to drop the real→alias correspondence.
- [x] Re-scan whole repo → 0 real-name hits.

## Phase 2: Verify
- [x] `npm test` 2012 / 0 / 0 after scrub.
- [ ] Fresh `npm test` pre-commit.

## Phase 3: Quality gates + release
- [ ] verification-before-completion.
- [ ] requesting-code-review.
- [ ] receiving-code-review.
- [ ] Version sync: package.json 1.26.21 → 1.26.22, CHANGELOG, FILELIST, tag.
- [ ] Commit (no Co-Authored-By). Push when Vin approves.
