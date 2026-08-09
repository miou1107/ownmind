# v1.26.107 — Tasks

- [x] `.github/workflows/test.yml` — ubuntu × node 20 / node 24 and macOS × node 20 gating,
      windows × node 20 reporting.
- [x] Establish empirically that a `continue-on-error` matrix leg is not sufficient: it still
      reports `failure` in `needs.<job>.result`, so the gate cannot tell "only Windows is red"
      from "everything is red". Split into two jobs.
- [x] Add the `ensure-console-build` step: `src/public/dashboard/` is gitignored, so a clean
      clone has no console and `GET /dashboard/portal/usage` returns 404. This is the same
      prestart `npm start` already runs, with `build:no-translate` to avoid needing LLM
      credentials.
- [x] `tests/install-failed-beacon-ps1.test.js` — extract dependencies recursively; fall back
      to PowerShell 5.1 on win32, which is what `install.ps1` actually invokes; assert the
      throw itself (`exit 3`) rather than an exit status that two different outcomes share.
- [x] `tests/scanner-schedule-repair.test.js` — assert the generated XML directly, keep
      `plutil` as a cross-check where it exists, and compare the part actually under test
      rather than two correct spellings of one directory.
- [x] `hooks/ownmind-session-start.sh` — `lock_age_seconds` tries each `stat` form separately
      and checks the result for digits. Reproduced in alpine first: `stat -f %m` prints a
      five-line filesystem report to stdout and exits 1.
- [x] `tests/update-lock-mutual-exclusion.test.js` — two cases driven by a stub `stat` on
      PATH, so they run on macOS as well. The whole point is that this is a defect a macOS
      developer cannot otherwise see. Both red before the fix.
- [x] Verified on a real Linux, node 20, non-root: 3954 tests, **3949 pass, 0 fail**, 5
      skipped. As root the container reports 2 failures, both "unwritable path" cases — root
      ignores mode bits, which is the container, not Linux.
- [x] Reverse-verified: removing the XML escaping in the helper turns the plist check red on
      Windows, naming the unescaped `&`; removing `Get-LastLogLines` from the recursive
      extraction turns the ps1 test red, saying the harness is no longer testing what ships.
- [x] CHANGELOG, FILELIST, README ×3, `package.json` → 1.26.107

## Renumbered on merge

Opened as v1.26.106, which was taken by the Windows-encoding work while this was open. Moved
to 1.26.107 — CHANGELOG heading, `package.json`, README banners, and the in-code version
annotations. Both CHANGELOG sections are kept in full.

## Measured, and deliberately not fixed here

- [x] The ubuntu × node 24 leg can still fail on `a leaked reclaim marker does not let two
      shell hooks into the critical section`. Reproduced in a one-CPU container: **1 in 40**
      runs on this branch, 0 in 40 on `main` — but `main` cannot reach that path on Linux at
      all, because `lock_age_seconds` returns garbage there, which is the bug this change
      fixes. `shared/update-lock.js` is byte-identical on both sides and its Node-side twin of
      the same case did not fail in 40 runs either.
      So: pre-existing protocol race, newly reachable on Linux. macOS has always taken this
      path and passes.
- [x] Closed one window of it in both implementations: after winning the move-aside of a
      `.reclaim` marker, check that what was moved is the stale marker that was measured, and
      stand down otherwise. Deterministic test on each side, both red before the change; both
      mutations red.
- [x] Measured what remains: 1-2 failures in 60 runs on a one-CPU container, shell side only.
      Traced with per-step timestamps — four processes become reclaimer in turn, each of them
      legitimately, because the first removes the marker as soon as it is done and the next
      sees "no marker, lock still stale". That is the protocol's shape, not the window above,
      and `shared/update-lock.js` already states delete-and-recreate cannot be made atomic.
      Not redesigned as a side effect of a `stat` fix.

## Not in this change

The Windows leg's 109 pre-existing failures. Clearing them is its own piece of work; until
then `continue-on-error` stays and a Windows regression can merge.
