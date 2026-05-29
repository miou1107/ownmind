# Tasks — v1.26.19 i18n tests/ comments + descriptions (Track B)

## Safety constraints (apply to EVERY edit)

- Translate ONLY comments (`//`, `/* */`, JSDoc) and `describe`/`it`/`test`
  description strings. NO identifier renames.
- NEVER change a string passed to an assertion or used as test data / fixture.
- Edit in place, surgically; never full-file rewrites.
- Translate a batch of files, run `npm test`, then move on.
- Compare pass COUNT (baseline 2012 / 0 fail / 0 skipped), not just "green".
- `git diff` self-check after each batch: only comments / test labels changed.

## Phase 0: Baseline

- [x] `npm test` fully green; record pass count (2012 / 0 / 0).
- [x] Build the precise file list (55 files with translatable comments/descriptions).

## Phase 1: Translate — batches (comments + describe/it/test descriptions only)

- [x] Batch 1 (14 files) — add-post-tool-use-hook … install-failed-beacon-ps1.
- [x] Batch 2 (14 files) — install-ps1-copy-safety … me-trailing-slash.
- [x] Batch 3 (14 files) — memory-sync-endpoint … scanner-codex.
- [x] Batch 4 (13 files) — scanner-lock … validators/registry.
- [x] Reverted 1 out-of-scope `assert.fail` string back to Chinese (install-failed-beacon-ps1).
- [x] Mopped up 3 stray pure comments + 1 pure label missed by the batches.

## Phase 2: Verify

- [x] Full `npm test` matches baseline (2012/0/0).
- [x] `git diff` scan: every removed Chinese line is a comment or describe/it/test
      label; no assertion value / fixture / test-data / product-literal string changed.
      Remaining Chinese in tests is preserved on purpose (assertion targets, fixtures,
      comments that quote literal product/data tokens).

## Phase 3: Quality gates + release

- [x] verification-before-completion (evidence: npm test 2012/0/0 twice).
- [x] requesting-code-review (reviewer on the diff — verdict CLEAN, byte-identical code).
- [x] receiving-code-review (no findings to act on).
- [x] Version sync: package.json 1.26.18 -> 1.26.19, CHANGELOG entry, tag v1.26.19.
- [x] Update FILELIST (added this proposal).
- [ ] Commit (no Co-Authored-By). Push when user approves.
