# Tasks

## 1. Measure the leak before changing anything

- [x] Confirm `fixture()` at `tests/sync-rules-block.test.js:38` creates a directory and
      nothing removes it
- [x] Count the accumulation on this machine: 391 `ownmind-block-*` directories, oldest
      2026-08-11
- [x] Measure one run in isolation by redirecting `TMPDIR`/`TEMP`/`TMP`: **23 per run**
- [x] Confirm the redirection technique works at all, so the guard can be built on it

## 2. Fix the leak

- [x] Track each directory `fixture()` hands out
- [x] Remove them in a file-level `after` hook, so a failing assertion cannot skip cleanup
- [x] Report a cleanup failure on stderr without failing the suite
- [x] Leave every test body and every assertion unchanged

## 3. Guard it

- [x] New file `tests/sync-rules-block-no-temp-leak.test.js` — the subject cannot watch its
      own `after` hook
- [x] Spawn the subject with its temp directory redirected to an empty one
- [x] Positive control: require a readable passing-test count of at least 20 before trusting
      the directory
- [x] Strip `NODE_TEST_CONTEXT` / `NODE_TEST_WORKER_ID` so the child uses the readable
      reporter (the control caught this on the first run)

## 4. Verify both directions

- [x] Fixed tree: guard passes
- [x] Unfixed tree (`HEAD` in a worktree, guard copied in): guard fails with
      `23 temp entries survived the run`
- [x] Full suite green apart from the two pre-existing `bare-mount-trailing-slash` failures,
      which need the gitignored `src/public/dashboard/` build output

## 5. Clean up and release

- [x] Record counts and dates first, then delete the 391 accumulated directories (IR-003)
- [x] Remove the control worktree
- [ ] CHANGELOG.md / FILELIST.md / README.md / docs/README.zh-TW.md / docs/README.ja.md
      (IR-008)
- [ ] Bump `package.json` to 1.26.153
- [ ] Commit, push, tag `v1.26.153`

## Not doing

**Auditing the rest of `tests/` for the same defect.** Worth doing and out of scope here; the
fix and its guard are file-specific, and a sweep is a different change with a different risk
profile. The guard added here is a template for it.
