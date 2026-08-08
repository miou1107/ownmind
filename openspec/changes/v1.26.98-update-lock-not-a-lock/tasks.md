# v1.26.98 — Tasks

- [x] Reproduce first: positive control in the test proves the harness can see a race at
      all, and that `touch` succeeds on an existing file
- [x] `shared/update-lock.js` — one implementation for both Node callers
- [x] `hooks/ownmind-session-start.sh` — `acquire_update_lock` mirroring it; caller takes
      the lock before logging `update_check`; losing logs `update_skipped`
- [x] `hooks/ownmind-session-start.js` — actually acquire, release when nothing was started
- [x] `mcp/index.js` — use the shared acquire and release; its own inline copy removed
- [x] Break each guard once: 8 mutations, all red. Two survived at first — the JS reclaim
      serialisation and the re-read — because eight processes released together take turns
      rather than overlapping. Suspected the test, not the code: added two deterministic
      tests that drive the interleaving directly. Both mutants then died.
- [x] CHANGELOG, FILELIST, README ×3, `package.json` → 1.26.98
- [x] `superpowers:requesting-code-review` — 1 Critical, 4 Important, 5 Minor. All acted on:
  - **Critical, and correct**: the stale-`.reclaim` cleanup was itself check-then-unlink, so
    two processes could both enter the deletion section and the second delete a fresh lock.
    Reproduced by the reviewer against both implementations with negative controls.
    - Their proposed fix (`rename`) does **not** close it — a late renamer moves the *fresh*
      marker instead, which is the same bug one level down. Pushed back and redesigned:
      delete-and-recreate is not atomizable, so the goal is "no two holders", not "no race".
      Move-aside for the marker, plus a written-and-read-back token so a displaced holder
      finds out and stands down. The overclaiming comment is gone.
  - Node hook reported `EROFS`/`ENOSPC` as `lock_held` → now uses `tryAcquireUpdateLock`
  - the `.stale` droppings test could never fail (nothing creates `.stale`) → `.reclaim`
  - missing update script logged `update_failed` every session → marker stamped first
  - Node racers imported the module after the start signal, so they never really contended
  - `.update-lock*` added to `.gitignore` — untracked files make `interactive-upgrade.sh`
    read a dirty tree and `git reset --hard`; a plausible cause of the two existing
    `upgrade_dirty_tree` warnings, and this change would have added a second such file
  - the skip/fail diagnosis was itself a TOCTOU → retries the acquire once before concluding
  - fail-closed `lock_age_seconds` documented as deliberate
- [x] Re-ran the mutation exercise after the redesign: **16 mutations, all red**, including
      the aged-marker scenario the first eight could not reach. Three guards needed
      deterministic tests, because the displacement check masks the serialisation layer —
      defence in depth hides its own lower layers from concurrency tests.
- [x] Node-side coverage closed in `tests/node-hook-parity.test.js`: skip on contention,
      lock before announcing, release when there is nothing to run. 4 mutations, all red.
- [x] Folded in at Vin's request after DESKTOP-8DD75VJ failed a pull with no recorded reason:
      `interactive-upgrade.sh` / `.ps1` now put the tail of the failing command's log into
      `detail`. 7 mutations, all red. The derived-call-site scan immediately found a seventh
      call site the hand edits had missed (`install_incomplete`), and the cap test found an
      off-by-one from `cut`'s trailing newline.
- [x] Backlog 37 opened for the empty `context` field. The `$args`-in-an-advanced-function
      theory is written down **as a guess** — there is no Windows machine here to run it on,
      so it is not recorded as the cause.
- [ ] Open the PR. **Do not tag or deploy** — Vin decides, and has said not to rush it.

## Notes for whoever reviews this

The shell and Node implementations are deliberate duplication, not drift. Spawning node to
take a lock costs more than the lock saves, so `acquire_update_lock()` mirrors
`shared/update-lock.js` step for step and `tests/update-lock-mutual-exclusion.test.js` runs
both through the same scenarios, including the staleness threshold.
