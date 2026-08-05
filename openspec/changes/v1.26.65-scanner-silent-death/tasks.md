# v1.26.65 — Tasks

Legend: `[ ]` pending · `[x]` done

Windows client scripts, the scanner entry point and one shared adapter. No server
change, no schema change, no migration, no console change.

## Phase 0 — Trace before designing (done)

- [x] Established from production that `~/.ownmind/package.json` is a single source
      for both MCP and scanner, so 1.26.59 on one and 1.26.29 on the other proves the
      scanner has not run since the upgrade
- [x] Established the scanner heartbeat carries no `os` and the MCP's does, so the one
      fresh row is the MCP
- [x] Ruled out the scanner succeeding under another account: nine machine names, nine
      users, no overlap
- [x] Read `register-scanner-task.ps1`, `run-hidden.vbs`, `interactive-upgrade.ps1`,
      `update.ps1`, `ownmind-usage-scanner.js`, `base.js`, `claude-code.js`
- [x] Confirmed `-Force` is a real `Register-ScheduledTask` parameter before using it,
      given this file's history of shipping invented parameter names
- [x] Withdrew a wrong conclusion about `sent=0` after checking where the events
      actually landed; that miss is what surfaced defect 5

## Phase 1 — RED

- [x] `tests/scanner-task-durability.test.js` (new):
  - [x] no `Unregister-ScheduledTask` anywhere in the registration script
  - [x] `Register-ScheduledTask` carries `-Force`
  - [x] the task is queried back after registering
  - [x] every `Register-ScheduledTask` parameter is a real one
  - [x] `run-hidden.vbs` waits, and quits with a variable rather than a literal
  - [x] the reschedule failure branch calls `Fail` and never says "upgrade itself
        complete"
  - [x] the scanner exits non-zero with no credentials, run as a real subprocess
        against a temporary HOME
- [x] `tests/scanner-blind-scan.test.js` (new):
  - [x] a missing base directory still returns empty
  - [x] an unreadable base directory throws rather than reporting empty, skipped when
        the environment cannot demonstrate it (running as root defeats permission bits)
  - [x] `scanned` counts visible files, and is 0 for a clean machine
  - [x] claude-code keeps the files it could read when one throws, and still heartbeats
  - [x] the skip is reported with its error code, not just counted
  - [x] codex survives a session archived between the listing and the open
  - [x] a clean run reports nothing skipped
  - [x] a non-Error throw does not put the word "undefined" in the log line
  - [x] codex survives one unusable token_count line, keeping the file and the heartbeat
- [x] Run; all fail for the right reasons

## Phase 2 — GREEN

- [x] `scripts/windows/register-scanner-task.ps1` — drop the unregister step, add
      `-Force`, verify afterwards
- [x] `scripts/windows/run-hidden.vbs` — wait and propagate the exit code
- [x] `scripts/interactive-upgrade.ps1` — `Fail` on a failed re-registration
- [x] `hooks/ownmind-usage-scanner.js` — throw on missing credentials; log `files=`
- [x] `shared/scanners/claude-code.js` — export `defaultListJsonlFiles`, distinguish
      ENOENT, return `scanned`
- [x] `shared/scanners/base.js` — pass `scanned` through as `files`, `skipped` as-is
- [x] Both Tier 1 adapters — guard `readIncremental` per file, collect error codes,
      keep the heartbeat (folded in at Vin's request after the first review round)
- [x] `shared/scanners/codex.js` — guard `buildEventFromTokenCount` per line as well.
      Found by asking why the live symptom is "never" rather than "sometimes"
- [x] Tests pass, including the pre-existing `ps1-windows-compat` suite

## Phase 3 — Docs and version

- [x] `package.json` → `1.26.65`
- [x] `CHANGELOG.md`
- [x] `FILELIST.md` — the two new test files
- [x] `README.md` three-locale check. The first pass grepped for the mechanisms and
      concluded nothing to sync, which was wrong: line 5 of each locale carries the
      current version. Caught by the pre-commit gate, not by me. All three bumped
- [x] Correct the recorded diagnostic for this fault: its first step reads
      `LastTaskResult`, which could not detect the fault before this release
- [x] `openspec/BACKLOG.md` — items 14 (`collector_heartbeat` per-user uniqueness),
      15 (`renderBroadcasts` hardcoded "snooze upgrade") and 16 (orphaned node)

## Phase 4 — Quality gates

- [x] `npm test` — full suite
- [x] Adversarial review through the `agy` CLI, against a copy outside the repo. Two
      findings: a vacuous test on Windows (real, fixed with a platform-independent
      ENOTDIR case) and orphaned node processes (real, pre-existing, backlogged as 16).
      Round 2 over the sixth change: one finding, a non-Error throw logging "undefined"
      (real, fixed). Round 3 over the seventh: no findings, and the load-bearing claim
      about offsets advancing was verified independently rather than taken on trust
- [x] `superpowers:receiving-code-review`
- [x] `superpowers:verification-before-completion`

## Phase 5 — After release

- [ ] Get one line from the affected machine to identify which of the five defects
      fired. Server data cannot answer this

## Out of scope

- Any alert, broadcast or notification. Built on 2026-08-05 and removed the same day
  after Vin's correction that an alarm is not a cure
- `collector_heartbeat`'s `UNIQUE (user_id, tool)`, which makes one person's two
  machines overwrite each other
- macOS launchd and Linux systemd equivalents
