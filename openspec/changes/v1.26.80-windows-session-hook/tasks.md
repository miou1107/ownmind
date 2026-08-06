# v1.26.80 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Measure

- [x] Vin said "adam 和 采瑤是 windows". Joined `collector_heartbeat` / `install_check_logs`
      against `activity_logs` init source and the split was total: every Mac loads the hook,
      no Windows machine ever has.

      ```
      Vincent.local                    darwin   11275 hook loads
      cengmingxuandeMacBook-Pro.local  darwin     675
      phoebelin.local                  darwin     271
      after            (Adam)          win32        0
      LAPTOP-G95HIQ3V  (Eric)          win32        0
      LAPTOP-MBGGLV2J  (采瑤)           win32        0
      LAPTOP-RGE2HCSQ  (Amiee)         win32        0
      Fontrip-Joanna                   win32        0
      TANK / DESKTOP-8DD75VJ           win32        0
      ```

      90 days, six machines, zero. The OS came from `install_check_logs`, which has carried
      `platform` all along — nothing joins it to anything, so it took a deliberate dig.
- [x] Falsified the first theory before building on it. "compact mode drops
      `INSTRUCTIONS_SOP`, so the AI is never told to log sessions" fit the session-log data
      — until the compliance instruction, which *is* sent in compact, turned out to produce
      0 for Phoebe and 采瑤 as well. Delivery was not the variable.
- [x] Root cause read straight from the source, no Windows machine needed: `install.ps1`
      chooses Node when no bash is found, and `update.ps1` recognises that entry, sees it
      lacks the four matchers `install.ps1` never adds, deletes it, and writes bash back.
- [x] Second defect: `Get-Command bash` finds `System32\bash.exe` on Win10/11 — the WSL
      launcher. `scripts/windows/lib/find-git-bash.ps1` exists in this repo precisely to
      "避開 WSL relay", and was wired into the upgrade verify step, never into the hook.

## Phase 1 — RED

- [x] `tests/session-hook-command.test.js`, red on a module that did not exist.
- [x] The Windows branch is exercised for real, not asserted about: the actual `node -e`
      block is extracted from `scripts/update.sh` and executed against a sandbox HOME with
      `process.platform` forced to `win32`.

## Phase 2 — GREEN

- [x] `scripts/install-helpers/session-hook-command.cjs` — `sessionStartCommand`,
      `sessionStartEntries`, `isOwnmindSessionEntry`, `isGeneratedCommand`, `needsRewrite`.
- [x] `install.sh`, `install.ps1`, `update.sh`, `update.ps1` all route through it.
- [x] `install.ps1` writes all four matchers, so the update script has no reason to tear
      its work down.
- [x] `update.ps1` now refreshes the Node hook files, which it never did.
- [x] **Caught while writing it, and it decides whether this release does anything at all.**
      The rewrite condition was "matchers incomplete". Every affected machine has all four
      matchers, all on bash. That condition calls them healthy. Shipped as first written,
      this release repairs zero of the six machines it exists for.

## Phase 3 — Verify

- [x] New file: 23 tests, 0 failures. Full suite: 2997 tests, 2995 pass, 0 fail, 2 skipped.
- [x] `bash -n` on both shell scripts.
- [x] **The real `update.sh` node block, executed** against a sandbox HOME, four scenarios:

      | scenario | result |
      |---|---|
      | Windows, the exact state of the six machines | all four bash → node |
      | second run | no change (idempotent) |
      | macOS | untouched, still bash, four matchers |
      | user's own `--verbose` variant | left alone |
      | helper missing from disk | SessionStart skipped, other hooks still installed |

- [x] **A harness failure nearly passed as a result.** The first Windows run reported "no
      rewrite", which read as a defect in the code. It was `require('module')._compile`
      not existing in Node 24 — the block never ran. Same shape as every other false
      negative this week: check the instrument before believing the measurement.

## Phase 4 — Review

One round against a non-git copy outside the repo. Six findings; four fixed, one accepted,
one recorded as follow-up work.

- [x] **`needsRewrite` fought the user.** Any command differing from the generated one was
      overwritten daily, forever, with no way to win. Now `isGeneratedCommand` gates it: we
      only replace strings we wrote.
- [x] **`require` could kill the whole script.** On the update that delivers the helper, or
      after a partial pull, `MODULE_NOT_FOUND` would skip PreToolUse, Stop and
      WorktreeCreate too. Wrapped; the SessionStart block is skipped instead.
- [x] **`isOwnmindSessionEntry` had no test against false positives.** Loosening its match
      to `"ownmind"` would have it claim the iron-rule hook, and every existing test would
      still pass. Named mutation, now covered.
- [x] `update.sh` referenced `$HOME/.ownmind` directly; switched to `$OWNMIND_DIR` for
      consistency. The reviewer's premise — that `OWNMIND_DIR` is user-overridable there —
      is wrong; line 14 assigns it unconditionally.
- [x] **A `"` in a Windows username would break the quoting.** Windows forbids `"` in path
      components. Not defended against.
- [ ] **The Node hook is not equivalent to the bash one — the sharpest finding.** Eight
      things missing, of which broadcasts and memory-file sync are user-visible. Measured
      rather than taken on trust. Backlog item 26. This release still takes Windows from
      nothing to memories-and-iron-rules; it does not make it whole.

## Phase 5 — Sync

- [x] `package.json` 1.26.80, `README.md` ×3, `CHANGELOG.md`, `FILELIST.md`
- [x] `openspec/BACKLOG.md` item 26

## Phase 6 — Out of scope, recorded

- [ ] Unverifiable on Windows until item 24 has a machine. The proof is one number moving:
      hook-sourced `init` events from a Windows machine going from 0 to non-zero.
- [ ] 采瑤's OwnMind has effectively never run (12 activity events, ever, against 2,854
      work events in two weeks). This release removes one reason. Whether it was the only
      one is not yet known.
