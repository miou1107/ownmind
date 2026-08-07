# v1.26.90 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Establish what is actually broken

- [x] Traced the hook with `bash -x` on Windows 10 / Git Bash / node v25.8.1 against the
      real payload. `COMMAND=` empty, `exit 0`.
- [x] Removed `2>/dev/null` to see the suppressed error: `ENOENT … 'C:\dev\stdin'`.
- [x] Checked the second half separately on macOS, where `/dev/stdin` works: the installed
      v1.26.89 hook is silent on the real payload and prints the reminder on the bare one.
      So the extraction defect is platform-independent and the blast radius is everyone,
      not Windows users.
- [x] Checked the `.js` sibling: stdin read is fine, extraction identical. Both change.
- [x] Checked whether any other hook reads a top-level `.command`. None does.

## Phase 1 — Fix

- [x] Four `readFileSync('/dev/stdin')` → `readFileSync(0)` in the `.sh`.
- [x] `(p.tool_input && p.tool_input.command) || p.command || ''` in both copies.
- [x] `bash -n` and `node --check` on both files.

## Phase 2 — Pin it

- [x] `tests/iron-rule-hook-payload.test.js` runs both hooks for real against a local HTTP
      server, using "did it reach the rules endpoint" as the signal.
- [x] Repo-wide `/dev/stdin` scan, file list grown from `git ls-files`, with a
      fails-closed assertion on the listing size.
- [x] Positive control, from a backup copy rather than `git checkout`: reverting the
      extraction turns both real-payload tests red while the bare-payload tests stay green
      (correct — the old code handled that shape); reverting to `/dev/stdin` turns the
      repo-wide scan red. Restored from backup, suite green again.

## Phase 3 — Fix what the change broke on the way in

- [x] The first draft's comment inside the `node -e` block contained `\$COMMAND`, which the
      v1.26.88 guard reads as an unconverted interpolated path. `npm test` was red on the
      branch. Reworded, and left a note in the block saying why.

## Phase 3b — What the fix un-hid

The hook had a large tail that had never executed. Restoring it restored all of it at once.

- [x] `git push` was blocked in ANY repository: the version gate compares OwnMind's own
      version against `git tag -l` in the user's cwd. Reproduced in a blank test repo.
      Scoped to the OwnMind checkout in both copies.
- [x] The `.sh` reminder went to bare stdout, which a PreToolUse hook exiting 0 never
      delivers to the model — while the reminder text itself instructs the AI. Wrapped in
      `hookSpecificOutput`, like the other output paths in the same file already were.
- [x] The `.js` copy contacted the API before every Bash call and emitted an empty context
      blob. Skipped for the non-trigger fallback; silent when there is nothing to say.
- [x] A non-string `command` cleared the empty-value guard. Type-checked.
- [x] Enforcement: downgraded from block to report. See below.
- [x] Every one of the above pinned by a test, each verified by mutation. One of those
      tests was vacuous on the first attempt — a non-string object stringifies to something
      no trigger matches, so the assertion held whether or not the type was checked.
      Rewritten with an array, which does match, and re-mutated.

## Phase 3c — Enforcement stays off

- [x] Measured the real blast radius rather than reasoning about it: on one account, 20 of
      27 cached rules carry a blocking mark; `git push` would be stopped by 6, `git commit`
      by 3 on the Windows copy (the `.sh` copy does not evaluate commit at all — an
      inconsistency worth its own fix).
- [x] Established that clearing a local cache is worthless: the MCP layer overwrites it from
      the server on init and after every rule mutation. The contamination is server-side.
- [x] Independent adversarial review consulted, given the code and the measured data. It
      reached the same conclusion and named the cache-refill point independently.
- [x] Blocking downgraded to reporting in both copies; failures still listed. The OwnMind
      version gate keeps blocking — product logic, not user data, and scoped to that repo.
- [x] Backlog 31: clean the stored data, give users a way to manage it, reconcile the two
      copies' scope, then re-enable as one change.

## Phase 4 — Docs

- [x] `CHANGELOG.md` — corrected the scope claim from Windows-only to all platforms.
- [x] `README.md`, `docs/README.zh-TW.md`, `docs/README.ja.md` — version line and feature
      bullet in all three. The branch as first pushed had bumped only the English one.
- [x] `FILELIST.md`, this change folder, backlog item 30 for the `2>/dev/null` work.

## Phase 5 — Release gates

- [x] Full suite: 3242 tests, 0 fail (dashboard static assets linked into the worktree;
      without them two pre-existing tests fail on `origin/main` too).
- [x] Code review requested and processed.
- [ ] Real-machine re-verification on Windows after release.
- [ ] Ask before tagging or deploying. A previous release is not authorisation.
