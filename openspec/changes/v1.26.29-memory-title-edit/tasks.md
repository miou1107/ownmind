# Tasks — v1.26.29 memory title editing via ownmind_update

## Phase 1: TDD (done)

- [x] Write tests/memory-title-update.test.js (source-level checks on
      mcp/index.js + src/routes/memory.js). Verified RED (4 fail).
- [x] mcp/index.js: add title to ownmind_update inputSchema + forward in
      handler.
- [x] src/routes/memory.js PUT: empty-title 400 guard + title_change history
      metadata. Verified GREEN.

## Phase 2: Quality gates (done)

- [x] verification-before-completion — red-green replay (stash impl → 4
      fail, pop → pass) + full suite green.
- [x] requesting-code-review — verdict approve-with-fixes: 2 Important
      (I1 __upgrade_test__ rename-to bypass, I2 tests not pinning gates),
      3 Minor (M1 untrimmed title, M2 secret guard skips title-only change,
      M3 title:null behavior change undocumented).
- [x] receiving-code-review — I1 fixed (rename-to prefix → 400; corrected
      the reviewer's overstated delete leg: test-cleanup also requires
      is_test=TRUE which PUT cannot set), I2 fixed (tests pin titleChanged
      gate + typeof check), M1 fixed (trim), M2 fixed (contentChanged ||
      titleChanged), M3 documented in proposal + CHANGELOG. All fixes TDD
      red→green; full suite 2049 pass / 0 fail.

## Phase 3: Release

- [ ] package.json 1.26.28 → 1.26.29; CHANGELOG; FILELIST; trilingual README
      version lines; commit; tag; push.
- [ ] Deploy server (docker compose build --no-cache) + upgrade local client.
- [ ] Live verification: rename a memory title via ownmind_update.
