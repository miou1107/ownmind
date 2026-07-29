# v1.26.38 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Investigation (done before this proposal)

- [x] Confirm the summary layer is intentionally global (`src/routes/memory.js:418-424`)
- [x] Confirm all four read paths scope by `user_id` (424 / 813 / 877 / 897)
- [x] Confirm fragments are inserted with the uploader's `user_id` (`1825-1835`)
- [x] Query production: 7 active summaries hold 119 active fragments; 127 active
      fragments total, all owned by one account
- [x] Confirm fragment contents are substantive, not placeholder debris
- [x] Confirm `ownmind_get`'s enum omits `standard_detail` (`mcp/index.js:442`)
- [x] Confirm orphan case exists today (summary 173 disabled, 8 active fragments)

## Phase 1 — RED tests (IR-003: reproduction before fix)

- [x] Create `tests/memory-visibility.test.js`
- [x] Own rows readable for any type
- [x] `team_standard` readable across users
- [x] `standard_detail` readable across users when parent is active
- [x] `standard_detail` hidden when parent is disabled
- [x] `standard_detail` hidden when caller opted out of the parent
- [x] Private types stay owner-only
- [x] Malformed / absent `metadata.parent_id` yields no match and no cast error
- [x] Emitted SQL parameterizes the user id (no string interpolation)
- [x] Route guard: `PUT /:id` and disable still contain `user_id = ` in WHERE
- [x] Run the suite and confirm the new tests FAIL for the right reason

## Phase 2 — Implementation

- [x] Add `src/utils/memory-visibility.js` with `SHARED_MEMORY_TYPES`,
      `isSharedMemoryType`, `buildReadableWhere`
- [x] `GET /type/:type` — route `standard_detail` through the shared branch
- [x] `GET /search` — swap the bare `user_id = $1` for the readable predicate
- [x] `GET /:id` — same predicate
- [x] Leave `/init`, `PUT /:id`, and disable untouched
- [x] Run the suite and confirm the new tests pass and nothing else regressed

## Phase 3 — Client side (IR-022: server and client both)

- [x] Add `standard_detail` to the `ownmind_get` enum (`mcp/index.js:442`)
- [x] Add a `standard_detail` label to `TYPE_MAP.ownmind_get`
- [x] Leave the `ownmind_save` enum unchanged

## Phase 4 — Docs and version (IR-008 / IR-026 / IR-031)

- [x] `CHANGELOG.md` — v1.26.38 entry
- [x] `FILELIST.md` — register `src/utils/memory-visibility.js` and the new test
- [x] `README.md` — update only if it describes standard sharing behaviour
- [x] Check the three README languages stay in sync (IR-032) if README changes
- [x] Bump `package.json` to 1.26.38 and keep the server version constant in sync

## Phase 5 — Quality gates (IR-012 / IR-045, mandatory)

- [x] `superpowers:verification-before-completion` — full `npm test` green;
      predicate additionally validated read-only against the live database
      because unit tests only pin the SQL string
- [x] `superpowers:requesting-code-review` — 1 Critical, 3 Important, 4 Minor
- [x] `superpowers:receiving-code-review` — each finding verified against the
      codebase before acting; see Phase 5b

## Phase 6 — Release and post-deploy verification

- [ ] Commit (no `Co-Authored-By`, per IR-024)
- [ ] Tag `v1.26.38` and deploy to kkvin.com
- [ ] Run any pending migrations under `db/` first (IR-048) — expected: none,
      this change adds no schema
- [ ] Post-deploy check from a non-uploader account: a fragment under summary
      135 is now readable, and one under disabled summary 173 is not
- [ ] Report back to Vin, then draft the note for Eric explaining that his
      uploaded standards were never shared and are now fixed

## Phase 5b — Review fixes (all verified, RED first)

- [x] Critical: admin-gate every shared type on POST / PUT / disable
      (`isSharedMemoryType`), closing the cross-account injection path the read
      widening would otherwise open
- [x] Important: `GET /:id` adds `(m.status = 'active' OR m.user_id = $2)` so a
      retired standard stays retired for non-owners
- [x] Important: `GET /type/:type` accepts optional `parent_id`; MCP
      `ownmind_get` threads it through. No LIMIT, so nothing truncates silently
- [x] Important: tighten three loose assertions to qualified names, add
      caller-binding-slot tests
- [x] Mutation-test the tightened assertions (they never went red, so prove
      they bite): removing `parent.type`, decorrelating the EXISTS, and
      unscoping the opt-out each fail exactly the intended test
- [x] Correct the false "banner renders undefined" claim in proposal, spec, and
      CHANGELOG — `resolveType` already falls back to `Memory loaded`
- [x] Record the 4 Minor findings as Known limitations in proposal.md
