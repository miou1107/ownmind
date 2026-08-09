# v1.26.103 — Tasks

- [x] Reproduce first, with a control. The initial reproduction was invalid — the seed
      commit was itself blocked by this machine's global pre-commit hook, so there was no
      HEAD and *everything* read as an addition. Re-run with `core.hooksPath` disabled for
      the sandbox, which is what showed the real `R100` with identical blob SHAs.
- [x] Failing tests first, in `tests/pre-commit-secret.test.js`:
      pure `git mv` passes · rename that appends a secret still blocks · rename that
      rewrites content still blocks · `diff.renames=false` behaves identically.
      The two "still blocks" cases are the negative control — without them, "never scan a
      renamed file" would also pass.
- [x] `hooks/ownmind-git-pre-commit.js` — `getRenameSources()`, `getStagedAddedLines()`
      takes the source path, `-M` explicit on both calls that decide what gets scanned
- [x] Mutations confirmed red: dropping `-M` fails 1, dropping the path pairing fails 4
- [x] Blob-SHA exemption written, then **removed** — no mutation could distinguish it, and
      an untested skip branch in a blocking security check is a hole, not a safeguard
- [x] End-to-end against the reported scenario with the real rule cache: the exact command
      from bug #10 now passes 7 rules
- [x] `superpowers:requesting-code-review`

## From review

- [x] **The one real defect, and it was a regression in the under-scanning direction.**
      Source paths come from git and go back to git as **pathspecs**; `--` does not disable
      that. A file committed as `:!victim.txt` is a legal filename and an exclude pattern,
      so pairing it with its destination cancelled the destination out of its own diff and
      the hook exited 0 on a freshly added `sk-proj-…` line. Verified independently before
      changing anything. Fixed with `--literal-pathspecs` on the content scan, plus a test.
- [x] `--literal-pathspecs` NOT added to the raw lookup, contrary to the review's wording:
      that call passes no pathspec, so the flag is a no-op. Confirmed by mutation — removing
      it fails nothing. Shipping a flag that does nothing under a comment saying it matters
      is the same defect as the stale comment below.
- [x] Stale `--no-abbrev` / SHA-comparison comment deleted — it described the removed
      exemption and would have led a maintainer to "restore" a flag that is not wanted.
- [x] Two-record test added (rename alongside an unrelated add). It does **not** pin the
      explicit non-rename token advance — that mutation is genuinely equivalent, since the
      loop resynchronises on the next token starting with `:` — and the comment now says so
      rather than claiming coverage it does not have.
- [x] **The first version of the pathspec test was vacuous.** All three mutations stayed
      green. Cause: a one-line seed file plus one appended line drops similarity below 50%,
      so git reported an unrelated delete and add, no pairing was attempted, and the test
      passed without reaching the code under test. Seed is now 60 lines; the mutation goes
      red. A test that has never been seen red is not evidence.
- [x] `spec.md` corrected — "both invocations" named three call sites; now says which two
      need `-M` and why `getStagedFiles()` does not.
- [x] `spec.md` known limits — the `diff.renameLimit` residual on move-plus-edit in a large
      batch, and the directory-prefix over-reporting that misnames a file in the block
      message. Both err towards scanning.
- [x] Full suite: 3595 pass, 0 fail, 2 skipped
- [x] CHANGELOG, FILELIST, README ×3, `package.json` → 1.26.103

## Still open

- [ ] Open the PR, reply on bug #10. **Do not merge, tag or deploy** — Vin decides all three

## Not done

- The `heuristic:long_alnum` filename match the report also noted
  (`flush-compliance-spool.js`). With the pairing fixed that file is no longer scanned
  during a move, so the reported symptom is gone. The heuristic has now produced four
  false positives and is a standing backlog item to reconsider as a strategy — adding a
  fifth exemption to it is the outcome to avoid.
- Bug #10's status in production is still `new`, along with eight others. Closing them out
  and notifying reporters is a separate decision, and one of the reporters is not Vin.
