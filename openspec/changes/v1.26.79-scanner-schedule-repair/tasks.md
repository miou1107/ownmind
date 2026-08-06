# v1.26.79 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Measure before designing

- [x] Established from production data, not from reading code: Adam's scanner heartbeats
      frozen at 1.26.29 / 07-15 while his MCP heartbeat moved that morning carrying
      1.26.67. Last `token_events` row 2026-07-15.
- [x] Ruled out "he stopped working": `activity_logs` shows `update_applied` at 09:03 the
      same day and 156 `update_skipped` over the month. The machine is alive and talking.
- [x] Identified which writer produces which row before drawing any conclusion from them.
      `os` is sent only by `mcp/index.js:358`, never by the scanner, which is what proves
      the fresh claude-code row is the MCP's and the four stale ones are the scanner's.
- [x] Found the repair already exists (`interactive-upgrade.ps1:195`, comment naming Adam)
      and traced why it never fires: only `bootstrap.ps1` reaches it.
- [x] Confirmed the ordering that makes a one-cycle fix possible: `mcp/index.js` pulls at
      :1685 and runs the update script at :1718, so the freshly pulled script is the one
      that executes.
- [x] Second user with the identical shape: Amiee Kuo, scanner frozen 07-27, last token
      event 2026-05-05.

## Phase 1 — RED

- [x] `tests/scanner-schedule-repair.test.js`, 20 tests. 19 red, 1 green.
- [x] The Unix helper is tested **behaviourally**: temp HOME, real plist / unit templates
      copied in, stub `launchctl` and `systemctl` on PATH whose state the test controls.
      The stub stands in for the OS, not for our code. The last three defects all got
      through suites that faked both sides of a contract.
- [x] The one test that was green from the start is a regression guard, and it is labelled
      as one: `git pull` must stay ahead of the update-script call in `mcp/index.js`. If
      that order ever flips, every fix in these scripts lands a release late.
- [x] PowerShell cannot execute here, so the Windows helper is read as text — the level
      `ps1-windows-compat.test.js` and `scanner-task-durability.test.js` already work at.

## Phase 2 — GREEN

- [x] `scripts/install-helpers/ensure-scanner-schedule.sh` — launchd / systemd. Health
      probe first, repair only if needed, re-query after, `report_error` on failure.
      `OWNMIND_OS` / `OWNMIND_DIR` overrides exist so both OS branches are reachable from
      one machine.
- [x] `scripts/install-helpers/ensure-scanner-schedule.ps1` — Task Scheduler. Treats
      `Disabled` as broken. Delegates registration to `register-scanner-task.ps1`.
- [x] `update.sh` / `update.ps1` call the helper and deliberately do not propagate its exit
      code, with the reasoning written at the call site.
- [x] `install.sh` — both Unix branches now re-query the OS after registering.
- [x] **A test caught a wrapper hiding the thing it was checking.** `Get-ScannerTask`
      wrapped `Get-ScheduledTask`, so "is Task Scheduler asked again *after* the repair"
      became unreadable at the call site. Removed the wrapper rather than loosening the
      assertion: the test was measuring the right thing.

## Phase 3 — Verify

- [x] New file: 20 tests, 0 failures, 0 skipped.
- [x] Full suite: 2975 tests, 2973 pass, 0 fail, 2 skipped (both pre-existing).
- [x] `bash -n` on the new shell helper.
- [x] **Probe discrimination, before trusting any result from it.** `launchctl list
      com.ownmind.usage-scanner` → exit 0; `launchctl list com.ownmind.does-not-exist` →
      non-zero. The health check can tell the two apart.
- [x] **Positive control against the real launchd**, not the stub: agent loaded → helper
      printed `already_registered`, exited 0, and the plist's md5 and mtime were unchanged
      afterwards. It really does leave a healthy schedule alone.
- [x] **Negative control: the failure reproduced on real launchd.** Unloaded the agent and
      deleted the plist, confirmed `launchctl list` no longer finds it and the file is
      gone, *then* ran the helper: `OK:schedule:repaired`, exit 0. launchd was asked
      afterwards and answered with `Label`, `PID 76461`, `LastExitStatus 0` — it is
      registered and it has already run. `{HOME}` occurrences in the written plist: 0.

      Same machine, same helper, one difference: whether the schedule was there.

## Phase 4 — Review

Two rounds against a non-git copy outside the repo. Nine findings, seven acted on, two
answered with reasoning.

Round one:

- [x] **`sed` replacement metacharacters in `$HOME`.** `&` in sed's replacement means "the
      whole match", so a home directory containing one would write the literal `{HOME}`
      back into the plist. Fixed in the helper and in `install.sh`, which has carried this
      since it was written.
- [x] **The fix was incomplete, and my own new test found the rest.** Escaping sed is not
      enough: the destination is XML, so `&`, `<` and `>` need entities as well, and the
      two passes have to run in that order because the XML pass emits a `&` the sed pass
      must then protect. `plutil -lint` on a sandbox HOME containing `&` is what caught
      it. The review did not.
- [x] **WSL and headless Linux would report a failure every day.** `systemctl --user`
      cannot reach a D-Bus session there, so probe fails → repair fails → report, daily,
      from every such machine, burying the real failures this report exists to surface.
      Now probes `show-environment` first and skips with a reason.
- [x] **`Get-ScheduledTask` could return an array**, at which point `$task.State -ne
      'Disabled'` stops being a boolean and PowerShell filters instead — a stranger's
      same-named task in another folder would vouch for ours. Pinned with `-TaskPath '\'`.
- [x] `update.sh` now captures the helper's output instead of letting a machine-readable
      line land at column 0.
- [x] **Root-owned plist from an old `sudo` install** — answered, not changed. The
      redirect failing returns non-zero and hits `|| fail`, which reports and exits 1.
      Round two agreed.

Round two, on the fixes:

- [x] **The static tests can be defeated, and it named the mutations.** Two were real and
      are now closed: both "reports the failure" assertions looked anywhere in the file,
      and each helper defines a no-op reporting fallback, so deleting the real call and
      leaving the polyfill would have kept them green. They now inspect the failure path
      itself. Verified by mutation: delete each call, leave each polyfill, both go red.
- [x] **Two mutations remain uncaught** (`if (-not $task)` → `if ($false)`; the `update.sh`
      call wrapped in `if false`). Written into the test file's header rather than left
      implied. Closing them needs PowerShell execution and a full `update.sh` run, neither
      of which belongs here.
- [x] **The `show-environment` probe would hide a real failure under `cron`**, which has no
      `DBUS_SESSION_BUS_ADDRESS` and would look like "no user session" on a machine where
      the timer works. Correct, and it does not apply today: the only caller is
      `mcp/index.js`, running inside the user's desktop session. The constraint is now
      written at the probe, so a second caller cannot inherit the assumption silently.
- [x] **A newline in `$HOME` breaks the `sed` command.** True. It also degrades safely:
      sed exits non-zero, `|| fail` reports it, exit 1. Not worth code.
- [x] Confirmed clean: escaping order, backslash / quotes / unicode / trailing slash,
      `-TaskPath '\'` against every Windows version with these cmdlets, and the exit code
      seen by `if SCHEDULE_RESULT="$(...)"` being the helper's.

## Phase 5 — Sync

- [x] `package.json` 1.26.79, `README.md` ×3, `CHANGELOG.md`, `FILELIST.md`
- [x] `openspec/BACKLOG.md` — item 25 (four users have never produced a real session log)
      recorded while investigating this; unrelated pipe, same page.

## Phase 6 — Out of scope, recorded

- [ ] `install.sh` still unloads before it loads on macOS. Verification now makes a
      failure visible, but the shape that turns one bad moment into permanent silence is
      unchanged. Restructuring it means handling "the template changed and the agent must
      be replaced", which the repair helper deliberately does not do.
- [ ] Nothing here has run on Windows. Backlog item 24 stands, and this release adds to
      what is waiting on that machine.
