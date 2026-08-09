# v1.26.104 — Tasks

- [x] Confirm the ordering claim directly rather than from documentation: a scratch repo,
      two commits in a row, and a hook at each stage printing what it can see.
      `PRE-COMMIT sees [FIRST MESSAGE]` / `COMMIT-MSG $1 contains [SECOND MESSAGE]`.
- [x] Quantify the blast radius before changing anything: production has 2 active rules
      using `commit_message_not_contains`, both one user's, both blocking, both about the
      trailer the shell guard already catches. Nobody has been silently unprotected — but
      the general mechanism has never worked.
- [x] Establish that `GIT_COMMIT_MSG` is test-only scaffolding. It appears twice in the
      repository: the fallback in `getCommitMessage()`, and `tests/pre-commit-secret.test.js`.
      The sandbox is a fresh repo with no `COMMIT_EDITMSG`, so the read always threw and the
      tests always took the branch production never takes.
- [x] Failing tests first — 10 of them, all red before any implementation
- [x] `hooks/ownmind-git-commit-msg.js` — evaluates `commit_message*` rules against argv[2],
      selected by condition type, never by rule code
- [x] `hooks/ownmind-git-commit-msg` — calls it, and skips it when the script is absent
      rather than treating that as a block
- [x] `hooks/ownmind-git-pre-commit.js` — `COMMIT_MSG_FILE`, `getCommitMessage()` and the
      `commitMessage` context key removed; message rules excluded from `commitRules` so
      they are not counted in "all N rules passed ✓"
- [x] `install.sh` and `install.ps1` — both ship the new script (checked both, not one)
- [x] Mutations confirmed red: restoring the stale read fails 3 (including the end-to-end
      retry); never blocking fails 4; dropping the bypass check fails 1; narrowing the
      condition filter to one type fails 1; ignoring argv fails 4; wrapper not calling the
      script fails 1; wrapper treating a missing script as a block fails 4
- [x] Full suite: 3608 pass, 0 fail, 2 skipped
- [x] CHANGELOG, FILELIST, README ×3, `package.json` → 1.26.104

## Corrected mid-flight

- [x] **Deleting the hardcoded trailer grep was wrong, and the existing tests said so.**
      `tests/git-hook-co-authored-by.test.js` went red on four cases. The rule engine's
      `commit_message_not_contains` is a case-sensitive substring test, so a rule reading
      `Co-Authored-By` does not match `Co-authored-by:` — git's own spelling. The grep is
      anchored and case-insensitive; it stays, and the change is now additive.
- [x] **Those tests were passing for the wrong reason too.** They drive the shell hook with
      the developer's real `$HOME`, where `~/.ownmind/hooks/ownmind-git-commit-msg.js` does
      not exist, so they never reach the rule evaluation. Added three wrapper-level tests
      with `$HOME` pointed at a sandbox that has the client installed — otherwise the whole
      new path would have had no coverage through the layer git actually invokes.
- [x] **The first sandbox install was a partial mirror** and produced ERR_MODULE_NOT_FOUND:
      copying the script without `hooks/lib/` and `shared/`. In a real install `~/.ownmind`
      is the git checkout, so the siblings are simply there; the test now copies them.

- [x] `superpowers:requesting-code-review`

## From review — every finding verified independently before acting

- [x] **CRITICAL: the release would have been a net loss of enforcement.** The auto-update
      path is `git pull` → `npm install` → `update.sh`, which never runs an installer.
      `~/.ownmind` is the checkout, so the new pre-commit lands instantly, but
      `~/.ownmind/git-hooks/commit-msg` is a copy that `update.sh` only stripped CR from —
      its own comment said "this script does not own their content". Confirmed on this
      machine: the installed wrapper is 560 bytes with zero references to `node`. So the
      user would lose pre-commit's message check and never gain commit-msg's, masked by the
      one rule the old wrapper's grep still catches. Both updaters now recopy the wrappers
      they find installed, and `update.ps1` did not touch that directory at all before.
- [x] **`git commit --verbose` false-blocked.** Reproduced with a faithful editor
      simulation (an editor that keeps git's template, which the first attempt did not):
      the scissors line arrives at line 17 and `+Co-Authored-By: …` at line 27, uncommented.
      Now truncated at the scissors line, with `core.commentChar` honoured.
- [x] **`set -e` plus `VAR="$(git rev-parse …)"` exited 128 silently.** Reproduced: running
      the wrapper outside a repository. `|| true` added.
- [x] **A message whose every line starts with the comment character disabled all message
      rules.** `git commit -m '#123 fix'` keeps that line in the real commit. Falls back to
      the un-stripped text now.
- [x] **Static imports made a partial install fail closed** with a stack trace, contradicting
      the file's own docstring. All project modules load via `await import()` inside `main()`.
- [x] `tests/git-hook-co-authored-by.test.js` now runs against a sandbox `$HOME`. It was
      passing only because this machine has no installed script; once one exists it would
      have started depending on the developer's own rule cache.
- [x] `isMessageRule` imported by pre-commit rather than reimplemented inline
- [x] Mutations for every fix confirmed red: scissors truncation 1, comment fallback 1,
      `|| true` 1, dynamic imports 1, `update.sh` source 1, `update.ps1` block 1
- [x] Full suite: 3620 pass, 0 fail, 2 skipped

## Corrected in my own mutation testing

- [x] The first `|| true` mutation reported "not caught" — it had silently failed to apply
      (`grep -c` still found the string). Re-applied with a real edit, and it goes red.
      A mutation that did not apply is not evidence of a weak test.

## Still open

- [ ] Open the PR. **Do not merge, tag or deploy** — Vin decides all three
- [ ] Depends on PR #67 (v1.26.103), which touches the same file

## Backlog

- Retiring the hardcoded trailer guard means one user's iron rule stops living in product
  code, but it can only follow making `commit_message_contains` /
  `commit_message_not_contains` case-insensitive — which changes matching for every
  existing rule and is its own decision.
