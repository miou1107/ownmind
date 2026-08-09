# v1.26.105 — Tasks

- [x] Measure the defect on the affected machine rather than infer it: two PreToolUse entries
      for the same hook, same file hash, different directory — `Bash` exits 1 with
      `ERR_MODULE_NOT_FOUND` on every call, `Edit|Write|MultiEdit|NotebookEdit` exits 0.
- [x] Establish why v1.26.92 did not reach it: its repair condition asks whether any command
      under the matcher mentions `ownmind-iron-rule-check`, and the broken command does. The
      broken entry satisfies its own repair condition, so only fresh installs were ever fixed.
- [x] Establish why the install self-check reported 6/6: `iron_rule_hook` asked whether a copy
      exists under `~/.claude/hooks`, not whether the registered command can start.
- [x] Establish why no test caught it: four copies of the logic, only the bash one reachable
      from CI, and reached by slicing a `node -e` string out of `install.sh` and evaluating it.
- [x] `scripts/install-helpers/ensure-pretooluse-hooks.cjs` — one implementation; rewrites a
      command that differs; `--bash` / `--node` for the two invocation styles; BOM tolerated;
      malformed JSON reported rather than overwritten; backup before any change.
- [x] `install.sh`, `install.ps1`, `scripts/update.sh`, `scripts/update.ps1` — all four
      delegate; the older single-matcher block in the two updaters (which wrote a bash command
      on Windows) removed with them.
- [x] `scripts/install-helpers/install-artifacts.cjs` — `iron_rule_hook` resolves the
      registered command's path; candidate list kept as the fallback when nothing is
      registered.
- [x] `tests/edit-trigger-reminder.test.js` — stops slicing `install.sh` and calls the helper
      directly, so the assertion covers all four scripts instead of one.
- [x] `.gitignore` — the six runtime paths, so upgrade stops judging its own files as user
      edits and taking the `git reset --hard` branch on every run.
- [x] 17 behaviour tests in `tests/ensure-pretooluse-hooks.test.js`, including that machine's
      actual `settings.json` as the regression case.
- [x] Verified on Windows against an unmodified v1.26.102, item by item:
      `edit-trigger-reminder` 22 pass / 14 fail → 24 pass / 12 fail; the ten install/hook
      files 89 pass / 7 fail → 101 pass / 7 fail. The remaining failures are identical on both
      sides and are that machine's environment (node cannot find `bash`, Windows permission
      semantics), unrelated to this change.
- [x] Verified on the affected machine: helper reports
      `repaired: Bash (was: node "C:/Users/Vin/.claude/hooks/ownmind-iron-rule-check.js")`,
      a second run reports `unchanged`, and the real payload then exits 0 where it exited 1.
- [x] CHANGELOG, FILELIST, README ×3, `package.json` → 1.26.105

## Renumbered on merge

Written and reviewed as v1.26.103. By the time it merged, 1.26.103 and 1.26.104 had both been
taken by work that landed first, so the release number moved to 1.26.105 — CHANGELOG section,
`package.json`, and the in-code version annotations. Nothing else changed.
