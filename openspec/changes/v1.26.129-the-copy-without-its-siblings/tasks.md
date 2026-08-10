# v1.26.129 — Tasks

- [x] Reproduce the v1.26.127 regression: run `hooks/lib/session-start-output.js` from a
      directory with no `shared/` sibling — ERR_MODULE_NOT_FOUND
- [x] Confirm the older instance: the installed `conditional-sync-cli.js` fails the same way
- [x] `hooks/ownmind-session-start.sh` — one `LIB_DIR`, all seven call sites through it
- [x] `tests/hook-lib-resolution.test.js` — including the reproduction, not just a string check
- [x] `shared/update-banner.js` + `hooks/lib/queue-update-banner.js` — queue the outcome
- [x] `hooks/ownmind-session-start.sh` — queue a banner on every update branch
- [x] `src/jobs/nightly-upgrade-reminder.js` — threshold and wording
- [x] Mutation checks: a reverted call site, and the copy-without-shared layout
- [x] `npm test` green; version, CHANGELOG, FILELIST and the three READMEs updated
- [x] Code review — two Important findings fixed: the banner reached only one of the three
      updaters (MCP and the Node hook now queue too), and the threshold change was invisible
      because superseded auto broadcasts were never retired
- [ ] Ship — Vin's call. This one matters more than usual: v1.26.127 and v1.26.128 are on
      `main`, and a machine that updates to either of them before this lands loses memory
      loading entirely
