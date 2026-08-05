# v1.26.39 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Diagnosis

- [x] Reproduce live: card reads 0 while the account holds 387 memories
- [x] Confirm `/export` shape: `{ exported_at, user_id, total_count, memories }`
      with `memories` grouped by type
- [x] Confirm the counting loop scans top-level values, none of which is an array
- [x] Confirm the request succeeds, so the `-` fallback never fires and the
      wrong `0` looks authoritative
- [x] Confirm pre-existing: neither file was touched by v1.26.38
- [x] Check the second occurrence (line 2796) — reads a different endpoint,
      verified live as correct, left alone

## Phase 1 — RED tests

- [x] Create `tests/admin-stats-memory-count.test.js`
- [x] Lift `countExportedMemories` out of the HTML and execute it, so the tests
      check behaviour rather than source text
- [x] total_count honoured; grouped lengths must not override it
- [x] Grouped fallback; legacy flat fallback
- [x] Empty / null / undefined / non-object / non-numeric total_count
- [x] `total_count: 0` treated as a real count
- [x] Wiring: loadStats uses the helper, broken loop gone, `-` fallback kept
- [x] Label states whose count it is
- [x] Run and confirm 8 of 9 fail for the right reason (the ninth, the `-`
      fallback, already held)

## Phase 2 — Implementation

- [x] Add `countExportedMemories(data)` to the admin inline script
- [x] `loadStats()` delegates to it; `catch` → `-` unchanged
- [x] Relabel the card 記憶總數 → 我的記憶總數
- [x] Full suite green (2132)

## Phase 3 — Docs and version

- [x] `CHANGELOG.md` — v1.26.39 entry
- [x] `FILELIST.md` — register the new test and the changed files
- [x] `README.md` — grepped all three languages; the card is not documented,
      so no sync needed
- [x] Bump `package.json` to 1.26.39

## Phase 4 — Quality gates (mandatory)

- [x] `superpowers:verification-before-completion` — full suite green; the
      counter additionally run against the real production payload
- [x] `superpowers:requesting-code-review` — 0 Critical, 3 Important, 6 Minor
- [x] `superpowers:receiving-code-review` — every finding verified against the
      codebase before acting; see Phase 4b

## Phase 4b — Review fixes

- [x] Important: `loadStats` throws on a non-OK response, so a 401/500 error
      body no longer counts as 0 (the file already did this in 28 other places)
- [x] Important: label 我的記憶總數 → 我的記憶（啟用中）, because `/export`
      filters `status = 'active'` while the stats tab labels 記憶總數 a figure
      that includes disabled rows
- [x] Important: wiring test pins the whole assignment — reviewer showed that
      writing the count into `totalUsers` kept every test green
- [x] Minor: the `total_count: 0` fixture now carries rows, so a
      `total_count > 0` guard is caught instead of passing
- [x] Minor: `Number.isFinite` replaces `typeof === 'number'`; `memories` as a
      plain array is handled instead of silently counting 0
- [x] Minor: dropped the false "backward compatibility" claim from the comment,
      proposal, spec, and CHANGELOG — `total_count` has existed since the first
      commit and the page is same-process, so those branches are pure defence
- [x] Minor: Phase 3 checkboxes brought up to date (this block)
- [x] Mutation-test the three hardened assertions: wrong element, `> 0` guard,
      and removed `res.ok` check each fail exactly the intended test
- [x] Backlog recorded: fetching 387 full records to read one integer

## Phase 4c — Not fixed, recorded instead

- [x] A true instance-wide memory count (573 across nine accounts) would need
      `/api/activity/stats/all`, which also computes compliance, tool and model
      breakdowns, and per-period activity for every user. Own change.

## Phase 5 — Release

- [ ] Commit (no Co-Authored-By)
- [ ] Tag `v1.26.39`, push, deploy to kkvin.com
- [ ] Run pending migrations first — expected none, no schema change
- [ ] Browser check: card shows the real count, not 0 and not `-`
- [ ] Also commit the leftover v1.26.38 `tasks.md` status update
