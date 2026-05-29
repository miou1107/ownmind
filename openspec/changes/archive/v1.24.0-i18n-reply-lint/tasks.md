# v1.24.0 — Tasks

## Phase 1: Survey

- [ ] Confirm all user-facing strings in `hooks/ownmind-reply-lint.js`
- [ ] Identify tests that assert against Chinese lint output

## Phase 2: Translation

- [ ] Session-off reminder text + tick milestone message
- [ ] Bug-report tip strings (×2 — block + downgrade paths)
- [ ] `formatBanner` — header / mode messages / downgrade banner / mode-invalid warning
- [ ] `formatPrivacySummary` — labels (Taiwan ID / Email / Mobile phone)
- [ ] `formatDowngradeNotice`
- [ ] `_EVENT_DISPLAY_NAMES` — event-to-name map
- [ ] `formatBlockReason` — 1st-block detailed prompt + 2nd/3rd-block short prompt + numbered violation instructions + annotation header template
- [ ] Brand banner `【】` → `[]`

## Phase 3: Verification

- [ ] `rg '[\p{Han}]|【|】' hooks/ownmind-reply-lint.js` only matches comments
- [ ] `node --check hooks/ownmind-reply-lint.js` OK
- [ ] `npm test` passes — update tests that assert on Chinese reply-lint strings
- [ ] Manual smoke: trigger a lint violation (mix Chinese and English in a response in this session) and confirm the rewrite prompt is English + Claude still annotates correctly

## Phase 4: Release

- [ ] Bump `package.json` to `1.24.0`
- [ ] Update `CHANGELOG.md`
- [ ] Update `FILELIST.md`
- [ ] Sync trilingual READMEs
- [ ] Commit
- [ ] `git tag v1.24.0`
- [ ] Archive change folder to `openspec/changes/archive/`
