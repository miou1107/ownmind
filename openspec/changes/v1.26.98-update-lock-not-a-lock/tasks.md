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
- [ ] `superpowers:requesting-code-review`
- [ ] Open the PR. **Do not tag or deploy** — Vin decides, and has said not to rush it.

## Notes for whoever reviews this

The shell and Node implementations are deliberate duplication, not drift. Spawning node to
take a lock costs more than the lock saves, so `acquire_update_lock()` mirrors
`shared/update-lock.js` step for step and `tests/update-lock-mutual-exclusion.test.js` runs
both through the same scenarios, including the staleness threshold.
