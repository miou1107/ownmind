# v1.17.66 — Windows platform hardening + observability pipeline fixes

- **Author**: Vin
- **Date**: 2026-05-08
- **Status**: Draft (awaiting Alice's Task Scheduler history screenshot to verify the Bug #7 hypothesis)
- **Worktree**: `objective-shamir-162fe2`
- **Branch**: `vin/objective-shamir-162fe2`

---

## 1. Why this change

On 2026-05-07 ~ 05-08, two days in a row, Alice and Bob both hit the same failure scenario running `bootstrap.ps1` on Windows to upgrade to v1.17.65:

1. `git pull` / `npm install` / `install.ps1` / `Task Scheduler re-registration` all OK
2. Failure suddenly hit at the `verify_local` step
3. This triggered `rollback`, but rollback also failed because the directory was in use
4. The two failures ironically ended up preserving the new version

Plus Alice additionally reported: "When OwnMind triggers, a PowerShell window pops up at random times, even when Claude isn't being used," hurting the work experience.

Further investigation revealed this is **not a single bug**, but an accumulation of mishandled Windows-platform behavior, and this is already the **third wave of the same class of issue**:

| Version | Windows-related bug |
|---|---|
| v1.17.62 | Windows EINVAL + MCP heartbeat stuck on old version |
| v1.17.65 | autostash fallback dead path |
| **v1.17.66** (this one) | Seven independent bugs, all rooted in "shell / path / process spawn assumed Unix behavior" |

Per the systematic-debugging skill's Phase 4.5: **3+ failed fixes of the same class = architectural problem, stop applying band-aids**.

---

## 2. Seven bugs and root causes (from real logs + code evidence)

### Bug #1 — PowerShell directly calling `bash` resolves to the WSL relay
- **Trigger point**: [scripts/interactive-upgrade.ps1:120,125,130](../../../scripts/interactive-upgrade.ps1) (3 places)
- **Evidence**: Alice log line 79–86: `<3>WSL ERROR: CreateProcessEntryCommon:505: execvpe /bin/bash failed 2`; Bob log same
- **Root cause**: Windows 10/11 ships `C:\Windows\System32\bash.exe`, which is a WSL relay (exists even with no distro installed); PowerShell's PATH resolution prefers System32, so bare `bash` always hits it
- **Severity**: 🔴 P0 (main cause of auto-upgrade failure)

### Bug #2 — `execFile + shell:true` on Windows is wrapped by cmd, swallowing the PowerShell pipeline
- **Trigger point**: [scripts/install-helpers/self-check.cjs:195-197](../../../scripts/install-helpers/self-check.cjs)
  ```js
  await execFileAsync('powershell.exe',
    ['-NoProfile', '-Command', "Get-ScheduledTask ... | Select-Object ..."],
    { timeout: TIMEOUT_MS, shell: true });   // ← root cause
  ```
- **Evidence**: identical error message on both machines: `'Select-Object' is not recognized as an internal or external command`; plus a DEP0190 deprecation warning
- **Root cause**: Node `execFile` with `shell:true` on Windows wraps `cmd.exe`; cmd reassembles the args and consumes `|`, piping the stdout of `Get-ScheduledTask ...` to `Select-Object`, an external command it does not recognize
- **Severity**: 🔴 P0 (self-check scheduler always false-fails)

### Bug #3 — `verify-upgrade.sh:49` feeds an MSYS path to native `node.exe`
- **Trigger point**: [scripts/verify-upgrade.sh:49](../../../scripts/verify-upgrade.sh): `node -p "require('${OWNMIND_DIR}/package.json').version"`
- **Evidence**: Bob running by hand in Git Bash: `Cannot find module '/c/Users/Bob/.ownmind/package.json'`
- **Root cause**: Git Bash's `$HOME=/c/Users/...` (MSYS format); Win32 `node.exe` does not understand a leading `/c/`
- **Severity**: 🟡 P1 (secondary bug, only surfaces after #1 is fixed → deferred to v1.17.67)

### Bug #4 — On upgrade failure, self-check is not triggered, and upload failure does not retry
- **Trigger point**: [scripts/interactive-upgrade.ps1:122](../../../scripts/interactive-upgrade.ps1) `Fail` exits before the self-check.cjs call at line 172
- **Evidence**: Bob 401 → self-check.cjs drops on upload failure, and the server `install_check_logs` table received no data at all
- **Root cause**: the failure path has no `try/finally` structure to guarantee observability; self-check.cjs:291-316 has no retry / no spool
- **Severity**: 🔴 P0 (silent precisely when data is most needed = inverted observability)

### Bug #5 — Windows rollback blocked by a file lock
- **Trigger point**: the `Rollback` function in interactive-upgrade.ps1
- **Evidence**: both machines saw `Cannot remove ... because it is in use`
- **Root cause**: the MCP server / Task Scheduler / an open Claude Code holds a file handle inside `.ownmind`; rollback does not stop these processes first
- **Severity**: 🟢 P2 (won't be triggered after #1 is fixed → deferred to v1.17.67)

### Bug #6 — PowerShell `Out-File` defaults to UTF-16 BOM
- **Trigger point**: [scripts/interactive-upgrade.ps1:120,125,130](../../../scripts/interactive-upgrade.ps1) `| Out-File -Append $LogFile`
- **Evidence**: Chinese garbled in Alice's log, with 0x00 between every character (a UTF-16 LE BOM signature)
- **Root cause**: PowerShell `Out-File` defaults to Unicode encoding (UTF-16 LE); modern tools expect UTF-8
- **Severity**: 🟡 P1 (observability pipeline pollution — logs uploaded to the server are also corrupted)

### Bug #7 — Scanner Task Scheduler pops up console windows
- **Trigger point**: [scripts/windows/register-scanner-task.ps1:78-100](../../../scripts/windows/register-scanner-task.ps1)
- **Evidence**: Alice reported "a window pops up at random times, even without using Claude"; history screenshot pending
- **Root cause**:
  - `-LogonType Interactive` + console-subsystem binary `node.exe` = Windows must open a console window
  - `-StartWhenAvailable` + 9999-day RepetitionDuration → Windows catch-up-runs missed triggers (waking from sleep, or reopening a closed laptop, fires several windows in a row)
- **Severity**: 🔴 P0 (directly hurts daily UX, flashes dozens of times a day)

---

## 3. Architectural finding (Phase 4.5)

The common pattern across the seven bugs:

> **Shell / path / process spawn assumed Unix behavior, failing systematically on Windows.**

OwnMind lacks three shared Windows layers:

1. **`find-git-bash` detection helper** — avoids the WSL relay; all PowerShell scripts that need to call bash use the same one
2. **`safe-spawn` Node wrapper** — Win32 `execFile` defaults to forbidding `shell:true`, forces `windowsHide: true`, and auto-timeout
3. **`path-to-win32` Node helper** — unified conversion between MSYS `/c/...` ↔ Win32 `C:\...`, normalizing before feeding a native binary

Without these three helpers, the next version will hit an eighth landmine. They must be done together this time.

---

## 4. Scope

### Included in v1.17.66

| Item | Bug | Fix summary |
|---|---|---|
| **Helper #1** `find-git-bash.ps1` | #1 | three-stage detection: `.git-bash-path` cache → common paths → `where bash` filtering out the WSL relay |
| **Helper #2** `safe-spawn.cjs` | #2, #6 | wraps execFile, defaults to `shell:false` + `windowsHide:true` + 5s timeout |
| **Helper #3** `path-to-win32.cjs` | (reserved for #3 in v1.17.67) | `/c/X` → `C:\X` bidirectional |
| **Helper #4** `run-hidden.vbs` | #7 | wscript GUI-subsystem launcher, fully hides the console |
| **Bug #1 fix** | #1 | interactive-upgrade.ps1 three bare `bash` → `& (Find-GitBash)` |
| **Bug #2 fix** | #2 | self-check.cjs:197 remove `shell:true` |
| **Bug #4 fix** | #4 | interactive-upgrade.ps1 self-check changed to `try/finally` to guarantee execution; self-check.cjs writes spool on upload failure (retry on next run) |
| **Bug #6 fix** | #6 | add `-Encoding utf8` to all `Out-File` |
| **Bug #7-a fix** | #7 | scanner task action changed to `wscript.exe run-hidden.vbs node.exe scanner.js` |
| **Bug #7-b fix** | #7 | task settings add `-DontStartOnBatteries -StopIfGoingOnBatteries`; frequency 30 → 120 min |
| **Environment info collection** | (Vin's request) | extend the `install_check_logs.full_log` schema (see spec.md §3) |
| **Admin dashboard view** | (Vin's request) | `/ownmind/admin/install-check` lists each user's last 5 self-checks + highlights failures |

### Deferred to v1.17.67 / v1.18.0

- Bug #3 (verify-upgrade.sh MSYS path) — wait for 24~48h of real samples after v1.17.66 deploys
- Bug #5 (rollback file lock) — same, requires first designing a "stop MCP / Task Scheduler then rollback" protocol
- Scanner event-driven architecture (MCP fs.watch + once-a-day catch-up) — major refactor

### Rollback trigger matrix (review fix — clarify the failure strategy for each upgrade step)

**Goes Rollback + Fail (a required upgrade condition failed → restore old version)**:
| Step | Why required |
|---|---|
| `git_pull` | the new version wasn't pulled; all subsequent changes are wasted |
| `npm_install` | MCP dependencies aren't installed; the runtime breaks outright |
| `install` | skill / hook / git-hooks aren't synced; the iron-rule enforcement engine fails |

**Goes Step warning, no Rollback (post-hoc health check, doesn't block the upgrade)**:
| Step | Why not required |
|---|---|
| `reschedule` | Task Scheduler wasn't re-registered; the scanner still works on the old registration |
| `verify_local` | local component grep — for health check, doesn't affect runtime |
| `verify_server` | server-connection health check, may just be a temporary network drop |
| `cleanup` | leftover test data doesn't affect functionality |
| `dismiss` | the upgrade broadcast wasn't cleared, just UI residue |

**Core principle**: Rollback is only for "not restoring = the system breaks"; verify is post-hoc observability, and on failure it goes through self-check uploading evidence to the server (IR-038), rather than dragging the user back to the old version.

---

## 5. Iron rules triggered

| Iron rule | How it's implemented |
|---|---|
| **IR-003** write a reproduction test before fixing a bug | tasks.md phase 1: write 7 reproduction tests first |
| **IR-004** use the OpenSpec development process | this OpenSpec is the implementation |
| **IR-005** no blind edit | Phase 1 hypothesis tree + Alice/Bob real logs as evidence |
| **IR-007** Persistent Bug Protocol | third time for the same class of issue; start the formal process + Phase 4.5 architectural refactor |
| **IR-008** commit must sync README/FILELIST/CHANGELOG | tasks.md wrap-up phase |
| **IR-022** OwnMind feature changes must cover both Server + Client | environment info collection = client collects + server stores + admin views |
| **IR-027** reminders don't work, only logic does | self-check upload changed to a logic gate (try/finally + spool), not relying on the user "remembering to run it" |
| **IR-031** the three version numbers must be in sync | tasks.md wrap-up: `package.json` + `SERVER_VERSION` + git tag |
| **IR-032** OwnMind README must be synced in three languages | tasks.md wrap-up: README.md + README.en.md + README.ja.md (or whichever languages actually exist) |
| **IR-038** (candidate) ensure enough observability data exists before fixing a bug | the environment-info extension + admin view is the implementation; write via `ownmind_save` after commit |

---

## 6. Out of scope

- Refactoring the scanner to be event-driven (MCP `fs.watch`) — v1.18.0
- Changing MCP to a Windows Service (avoiding Task Scheduler) — unnecessary, the v1.17.66 fix is enough
- Removing the 30/120-minute polling for pure events — needs to first verify fs.watch stability on Windows
- Real WSL user support (distro installed and wanting to use WSL bash) — no one asked, skip for now

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| VBS launcher false-flagged by Windows Defender / enterprise antivirus | using `wscript.exe` is the most widely accepted community standard; if still flagged, add an allowlist note to the README |
| `find-git-bash` detects nothing, user hasn't installed Git Bash | fallback `& powershell.exe` runs the .ps1 version of verify-upgrade (the .ps1 version is for v1.17.67; this version only fails loud) |
| existing log parser can't read the file after changing Out-File encoding | the existing parser already expects UTF-8 (confirmed by Alice's log); the change actually fixes it |
| environment info collection involves PII (hostname, PATH) | self-check.cjs already has `sanitizePath`; new fields go through the same redaction path |
| Task frequency 30→120 minutes makes data sparser | the scanner pulls past logs; a 2hr delay doesn't affect accuracy; the admin dashboard already shows a "data delay" indicator |

## 8. Code Review handling record (superpowers:code-reviewer, 2026-05-08)

The reviewer raised 6 risk points + 2 extra findings. After technical assessment:

### Accepted and fixed

| # | Problem | Fix location |
|---|---|---|
| #2 | `safeSpawn shell:true override` only logs a warning (no one reads Task Scheduler stderr) | [safe-spawn.cjs](../../../scripts/install-helpers/safe-spawn.cjs) changed to force `throw`; a caller that truly needs shell uses `child_process.execFile` itself |
| #3 | spool concurrency race condition (read-then-write loses data) | [self-check.cjs retrySpool](../../../scripts/install-helpers/self-check.cjs) changed to a rename pattern: `spool` is atomically renamed to `.processing.<ts>.<pid>` for processing, and the new appendSpool writes to a newly created spool; failed entries are appended back to the main spool via `appendFileSync` (O_APPEND atomic) |
| #4 | `WSL_DISTRO_NAME` may contain user-chosen names ("Bob-Ubuntu"), leaking PII | [detectShellChain](../../../scripts/install-helpers/self-check.cjs) changed to a boolean `'wsl'` flag, not passing the actual distro name |
| **#5** | **PowerShell `exit` inside try may skip finally** (MS docs say it runs, but real-world bug reports exist) | [interactive-upgrade.ps1 Fail()](../../../scripts/interactive-upgrade.ps1) changed to `throw "ERROR:..."`, with an outer `catch { print + exitCode=1 } finally { Run-SelfCheckOnce } ; exit $exitCode`. Ensures the IR-038 observability pipeline runs even on the failure path where data is most needed |
| #6 | spec doesn't state which steps Rollback vs warning; the next reviewer would hit the same problem | proposal.md §4 adds a "Rollback trigger matrix" explicitly listing: git_pull/npm_install/install → Rollback; reschedule/verify_local/verify_server/cleanup/dismiss → warning |
| extra | `register-scanner-task.ps1:118 description` still says "every 30 minutes" (IR-008 tri-sync) | changed to `every 120 minutes` |

### Rejected (push back, with evidence)

| # | Reviewer suggestion | Reason for rejection |
|---|---|---|
| #1 EDR auto-fallback | immediately `Start-ScheduledTask` after registration to check `LastTaskResult`; non-zero falls back to running node.exe directly | **YAGNI** — no user reported wscript being blocked by EDR; the fallback adds complexity (must distinguish "real failure" vs "EDR block"); if a real case appears, go to v1.17.67. This version only adds an allowlist suggestion to the README (in a later commit) |
| extra | `find-git-bash.ps1` cache hit still runs `bash --version`, adding 50ms each time | the reviewer admits low risk + left for v1.17.67; Find-GitBash is not on the hot path (called once per upgrade), so the 50ms overhead is acceptable |

### Clarified (reviewer misunderstanding)

| Reviewer claim | Actual situation |
|---|---|
| "IR-031's three version numbers must check `mcp/index.js` SERVER_VERSION" | the repo has no `SERVER_VERSION` constant. It's actually [mcp/index.js:154 `CLIENT_VERSION`](../../../mcp/index.js), **read dynamically** from `package.json`; changing `package.json` syncs it. The IR-031 implementation point for the three version numbers is `package.json` + the three READMEs, all already changed |
| "confirm the tri-lingual README filenames" | actually exist: `README.md` (English) + `docs/README.zh-TW.md` + `docs/README.ja.md`, all already synced |
