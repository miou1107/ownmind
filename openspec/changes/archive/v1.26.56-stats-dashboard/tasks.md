# v1.26.56 — 統計儀表板 tasks

## Phase 0 — Inventory

- [x] Read the legacy markup (`src/public/index.html:292-369`) and render JS
      (`:2777-3010`) block by block; all eighteen accounted for in `proposal.md`
- [x] Read all three endpoints in `src/routes/activity.js` — `/stats` (`:242`),
      `/stats/rules` (`:459`), `/stats/all` (`:558`) — and `getContextAnalysis` (`:38`)
- [x] **Correction to the umbrella list**: the memory-search modal is wired to the
      週/月報 tab, not this one. `data-search-text` appears at `:2750` and `:2761`, both
      inside `loadReport()`. Nothing on the stats tab opens it. Stage 7's call
- [x] **Defect found**: 各規則落地率 and 各工具落地率 band an unmeasured rate as a red
      0%. Fixed here, not carried over
- [x] Confirmed the user dropdown source is `/api/admin/users` (`usersData`), already
      loaded by the console's team page

## Phase 1 — Spec

- [x] `proposal.md`, `spec.md` (8 requirements), this file
- [x] `context: null` ambiguity recorded as a known limitation rather than guessed at

## Phase 2 — Tests first (RED)

- [x] `tests/stats-overview-vm.test.js` — activity window (including the boundary),
      never-active, pill ordering, null rate, real zero
- [x] `tests/stats-chart-data.test.js` — proportions, ordering, empty, all-zero
- [x] `tests/stats-compliance-vm.test.js` — band thresholds, null vs real zero,
      never-triggered kept separate, null rule title → translatable key
- [x] `tests/stats-detail-vm.test.js` — memory cards, health, handoff, context absent
      vs present-but-empty, and the fabricated init rate
- [x] `tests/stats-labels.test.js` — dictionary lookup, raw-key fallback, three-locale
      key parity, no Han characters left in en
- [x] Two assertions added to `tests/legacy-console-manifest.test.js`
- [x] All five confirmed red before implementing (module-not-found + manifest 3 vs 2)
- [x] Mutation-verified every guard that encodes a decision: `complianceBand(null)` →
      `'low'`, `rateRows` null → 0, the activity window `<` → `<=`, `has_usage_data`
      pinned true, the client ignoring the flag, `initRateMeasured` forced both ways,
      `ChartPair` stacked, and the bar width cap removed. Each turns the suite red

## Phase 3 — Implementation

- [x] Pure functions under `client/src/pages/Team/`
- [x] `StatsPage.jsx` — control bar and the two-view branch
- [x] `StatsOverview.jsx` — the eight-column table
- [x] `StatsDetail.jsx` — the single-user blocks
- [x] `charts.jsx` — `BarChart` and `DailyChart`, shared
- [x] Requirement 5 layout: short charts paired, main column capped. Verified by
      measuring bounding boxes in a real browser, not by matching class names

## Phase 4 — Wiring

- [x] 122 `stats.*` keys in `zh.json` / `en.json` / `ja.json`, three-way synced;
      every key used in code confirmed present in all three
- [x] Label lookup goes through the locale dictionary with a raw-key fallback — the
      legacy `ZH` map is not copied. `stats.label.null` exists because a NULL column
      survives GROUP BY as the literal string `"null"`
- [x] `App.jsx` import and `REAL_PAGES['/team/stats']`
- [x] `shared/legacy-console-manifest.js`: `stats-dashboard` → `live`

## Phase 5 — Quality gates (not skippable)

- [x] Full suite 2514 pass / 0 fail, e2e 26 pass / 0 fail, client build exit 0
- [x] `superpowers:verification-before-completion` — every requirement checked against
      a command that was run, with exit codes captured
- [x] `superpowers:requesting-code-review` — 1 Critical, 4 Important, 12 Minor
- [x] `superpowers:receiving-code-review` — each claim verified before acting. The
      `bool_or` claim was checked against a real postgres:16 container; the reviewer
      was right and my test comment was wrong

### Review outcomes

- [x] **Critical**: unguarded response race in `load()`. Extracted to
      `request-gate.js` with a test that reproduces the blank-page ordering
- [x] **Important**: the four context blocks now each render and name their reason,
      matching Requirement 6 rather than collapsing into one card
- [x] **Important**: unmeasured values name their cause instead of sharing one
      `尚無數據` label for four different situations
- [x] **Important**: e2e `SIGNPOST` derivation no longer role-filtered, so it cannot
      silently skip while a signpost exists
- [x] **Important**: the team page's usage column reads `session_count`, not
      `message_count`, so a tier-2-only member is not shown as `0 次對話`
- [x] **Minor**, applied: `bool_or` fixture corrected to FALSE with a null row kept as
      the defensive case; the context denominator is now displayed; `BarChart` takes
      pre-shaped rows instead of a round trip; the list separator and the date locale
      are i18n'd; a null rule title maps to the translatable `unknown`; the trigger
      chart is sliced to 5 so the "Top 5" heading is true; the label test's name matches
      what it checks
- [x] **Minor**, recorded not fixed (in the umbrella ledger): three sibling pages still
      hardcode `zh-TW` dates; `console-table-overflow` does not reach the new table

## Phase 6 — Release

- [x] Version 1.26.56 in `package.json` and all three READMEs
- [x] `CHANGELOG.md`, `FILELIST.md`, `README.md` + `docs/README.zh-TW.md` +
      `docs/README.ja.md`
- [x] Umbrella `tasks.md` Stage 5 ticked, with the corrections it surfaced
- [x] Commit `97659a8`, tag `v1.26.56`, pushed
- [x] Deployed to kkvin.com and verified in the browser. Details and the two
      production confirmations are in the umbrella ledger's Stage 5 section
- [x] One pre-existing bug found by the check and filed rather than fixed inline:
      `/ownmind/dashboard` without a trailing slash redirects off the `/ownmind`
      prefix onto an unrelated site (`express.static`'s absolute redirect at
      `src/app.js:82`). Predates this release; routing warrants its own change
