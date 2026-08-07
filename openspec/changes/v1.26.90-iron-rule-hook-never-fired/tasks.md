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
