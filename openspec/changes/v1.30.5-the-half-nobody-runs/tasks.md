# Tasks

## 1. Run the suite on the platform it ships to

- [x] Update the machine to v1.30.4 and verify the update landed on disk rather than trusting
      the installer's own success message
- [x] Full suite on Windows: 5436 tests, **15 failures**, none of which fail on macOS
- [x] Run every failing file individually — all fail in isolation, so none is a concurrency
      artifact

## 2. The enforcement bundle, which is the one that mattered

- [x] Trace the prompt line "this machine has never synced its standards" to a missing
      `~/.ownmind/cache/enforcement.json`
- [x] Confirm the server has something to give: a direct request returns 37 selectors
- [x] Find the cause — `syncEnforcementBundle` is called only from `conditional-sync-cli.js`
      `main()`, which only the `.sh` hook runs, and Windows registers the `.js`
- [x] Call it from `ownmind-session-start.js`, importing rather than restating it
- [x] Verify against a fresh home: the file is written, 37 selectors
- [x] `tests/windows-session-start-syncs-enforcement.test.js` — checked against the previous
      commit: **2 of its 3 cases fail there**

## 3. The silent no-op

- [x] `translate.mjs --dir` prints nothing and exits 0 on Windows
- [x] Cause: `import.meta.url === \`file://${process.argv[1]}\``, never true where argv[1] is
      `C:\…`
- [x] Fix with `pathToFileURL`
- [x] Grep for the same line elsewhere: one more, `hooks/lib/sync-memory-files.js` — correct
      only because nothing on Windows runs it as a CLI. Fixed anyway.
- [x] `tests/no-file-url-concatenation.test.js`, which asserts the premise separately on each
      platform

## 4. The tests that could not pass

- [x] Ten spawns close stdin (`node-hook-parity`, `node-hook-reports-init`) — 25s timeouts
      became sub-second passes
- [x] `real-db-lock`: file-URL specifier, `path.delimiter`, a `.cmd` stub on Windows — then
      **skipped on Windows anyway**, because `execFileSync` cannot launch a `.cmd` and the
      helper also shells out to `ls` and `cat`. The reason is in the skip message.
- [x] `gate-provisioning`: assert not-writable on Windows, and say in the same place that the
      key remains readable by other accounts there
- [x] `translate-hooks-dir`: an absolute path is absolute for the platform running the test

## 5. The two that were never a defect

- [x] `bare-mount-trailing-slash` needs the gitignored `src/public/dashboard/` build. Built it
      with `node scripts/ensure-console-build.js` — they pass. They were reported as
      "pre-existing failures" for weeks; they were an unbuilt asset.

## 6. Verify

- [x] Full suite on Windows with the temp folder counted before and after
- [x] The new guard and the new regression test each checked against the code they replace

## A correction worth recording

The first measurement of the session-start hook reported a 30-second hang with no output, on
both a fresh home and an unreachable server. That was wrong, and it was my own doing: the hook
was invoked without stdin being closed, so it was waiting rather than hanging. It was reported
as a Windows startup blocker before being re-run correctly.

The mistake is the same one the ten broken tests make, which is worth noticing: the failure
mode of this hook is indistinguishable from a hang unless you know it reads stdin, and nothing
about it says so at the point of use.

## Named and not done

- The Windows ACL on `gate.key` — the file is read-only there and still readable by other
  accounts.
- `tests/helpers/real-db.js` on Windows — `docker`, `ls`, `cat`.
- `hooks/ownmind-iron-rule-check.sh` carries 16 `2>/dev/null` redirections. It has no `set -e`,
  so it is not what IR-002 names, but it is the same silence and worth a pass of its own.
