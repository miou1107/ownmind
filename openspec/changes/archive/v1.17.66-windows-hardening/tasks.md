# v1.17.66 — Tasks

Execution list. Order is enforced: helpers → reproduction tests → fix bugs → observability extension → admin view → verification → tri-sync → review → commit.

---

## 0. Prerequisite (await Alice's Task Scheduler history screenshot)

- [ ] **Verify the Bug #7 hypothesis**: Alice's screenshot of the "OwnMind Usage Scanner" task history
  - Expected: on time every 30 minutes + occasional catch-up consecutive records
  - If not: pause the #7 fix, go back and grep for other possible sources

---

## 1. Helpers (build the foundation first; all subsequent bugs use helpers)

### 1.1 `scripts/windows/lib/find-git-bash.ps1`

- [ ] Create the file, implement the `Find-GitBash` function (spec.md §1.1)
- [ ] Detection order: cache → common paths → where bash filtering out the WSL relay
- [ ] Use `bash --version` to confirm it really is Git Bash (avoid a WSL distro also matching)
- [ ] Write cache to `~/.ownmind/.git-bash-path`

### 1.2 `scripts/install-helpers/safe-spawn.cjs`

- [ ] Create the file, export `safeSpawn(file, args, options)`
- [ ] Default `shell:false` + `windowsHide:true` + `timeout:5000`
- [ ] On failure return `{ok:false, error, stderr_tail}`, don't throw
- [ ] Log a warning when options passes `shell:true` (don't block)

### 1.3 `scripts/install-helpers/path-to-win32.cjs`

- [ ] Create the file, export `toWin32Path(p)` and `toMsysPath(p)`
- [ ] `/c/X` ↔ `C:\X` bidirectional
- [ ] No-op on non-Windows platforms

### 1.4 `scripts/windows/run-hidden.vbs`

- [ ] Create the file (content from spec.md §1.4)
- [ ] install.ps1 copies this file to `~/.ownmind/scripts/windows/`

---

## 2. Reproduction tests (IR-003: fail first, only then turn green)

Add to existing test files, no new files.

### 2.1 New cases in `tests/ps1-windows-compat.test.js`

- [ ] **#1 reproduction**: mock PATH with `C:\Windows\System32\bash.exe` first and Git Bash after → expect `Find-GitBash` not to return the System32 one
- [ ] **#1 fallback**: mock PATH with only System32 → expect `$null`
- [ ] **#6 reproduction**: run `Out-File` to write Chinese → expect the default UTF-16 BOM (red) → after fix expect UTF-8 with no BOM (green)

### 2.2 New cases in `tests/self-check.test.js`

- [ ] **#2 reproduction**: mock-intercept spawn → expect args not wrapped by a cmd shell; for a PowerShell pipeline command confirm `|` is not treated as a cmd pipe
- [ ] **#4 reproduction (a)**: mock upgrade failure (throw) → expect self-check.cjs still called
- [ ] **#4 reproduction (b)**: mock fetch 401 → expect the report written to the spool instead of dropped
- [ ] **#4 reproduction (c)**: given spool content + mock fetch 200 → expect the spool emptied and all reports sent
- [ ] **#7 acceptance**: register-scanner-task.ps1 dry-run output contains `wscript.exe` and `run-hidden.vbs`, **not** bare `node.exe -Execute`

### 2.3 Confirm all reproduction tests fail first

- [ ] Run `npm test` and see the seven new tests all red, old tests all green

---

## 3. Fix bugs (one commit per bug, in order)

### 3.1 Bug #1 — interactive-upgrade.ps1 three bare `bash`

- [ ] Change line 120, 125, 130 to use the `Find-GitBash` helper
- [ ] Add fallback: no Git Bash found → skip verify but don't block the upgrade
- [ ] Run #1 reproduction and turn green

### 3.2 Bug #2 — self-check.cjs remove `shell:true`

- [ ] [scripts/install-helpers/self-check.cjs:195-197](../../../scripts/install-helpers/self-check.cjs) change to use `safeSpawn`
- [ ] Remove `{ shell: true }`
- [ ] Run #2 reproduction and turn green

### 3.3 Bug #4 — self-check observability pipeline guaranteed to run + failure spool

- [ ] interactive-upgrade.ps1: change self-check from line 172 to a try/finally structure
- [ ] interactive-upgrade.sh: sync, add `trap` to guarantee execution
- [ ] self-check.cjs: implement the two functions `appendSpool` + `retrySpool`
- [ ] uploadReport: write spool on 401/403/network failure
- [ ] uploadReport: at the start of each self-check run, first try to re-send the spool
- [ ] Run #4 reproduction, all three green

### 3.4 Bug #6 — Out-File add `-Encoding utf8`

- [ ] grep the whole repo for all `Out-File`, `Set-Content`, `Add-Content` without -Encoding
- [ ] Add `-Encoding utf8` to all
- [ ] Run #6 reproduction and turn green

### 3.5 Bug #7-a — Scanner VBS launcher

- [ ] [scripts/windows/register-scanner-task.ps1](../../../scripts/windows/register-scanner-task.ps1) change Action to `wscript.exe run-hidden.vbs ...`
- [ ] install.ps1 ensures `run-hidden.vbs` is copied to `~/.ownmind/scripts/windows/`

### 3.6 Bug #7-b — Scanner task settings

- [ ] [scripts/windows/register-scanner-task.ps1:89-98](../../../scripts/windows/register-scanner-task.ps1) trigger interval 30 → 120 minutes
- [ ] settings add `-DontStartIfOnBatteries -StopIfGoingOnBatteries`
- [ ] Run #7 acceptance and turn green

---

## 4. Environment info collection extension (IR-038 implementation)

### 4.1 self-check.cjs `buildReport` extension

- [ ] Add a `collectEnv()` function, collecting all fields in spec.md §3.1
- [ ] Run `bash_resolution` only on Windows (call where.exe)
- [ ] Run `scheduler_detail` only on Windows (run PowerShell via safeSpawn)
- [ ] Redact $HOME everywhere with `sanitizePath`

### 4.2 Upgrade trace collection (trigger=post_upgrade)

- [ ] interactive-upgrade.ps1 writes the step trace to `~/.ownmind/logs/.last-upgrade-trace.json`
- [ ] interactive-upgrade.sh sync
- [ ] self-check.cjs reads `.last-upgrade-trace.json` into `full_log.upgrade_trace`

### 4.3 File lock detection (Windows)

- [ ] Add `scripts/install-helpers/check-file-locks.cjs`, detecting via `Get-Process` + `handle.exe`
- [ ] Run only when trigger=manual_after_failure or a rollback failure is detected
- [ ] Skip if handle.exe isn't installed (don't block)

### 4.4 Server-side confirmation

- [ ] [src/routes/debug.js:30-33](../../../src/routes/debug.js) confirm `env`, `upgrade_trace`, `file_locks` are all accepted by the 64KB validator
- [ ] New fields are inside the `install_check_logs.full_log` JSONB, no migration needed (already JSONB)

---

## 5. Admin dashboard view (spec.md §4)

### 5.1 Backend

- [ ] [src/routes/admin.js](../../../src/routes/admin.js) add `GET /api/admin/install-check`
- [ ] Support filters: `?user_id=...&trigger=...&has_fail=true&days=7`
- [ ] super_admin role check
- [ ] Default to the last 7 days, limit 100

### 5.2 Frontend

- [ ] Add `/ownmind/admin/install-check.html` (or an existing admin SPA route)
- [ ] List + detail modal
- [ ] Failure highlight (red label)
- [ ] Click a row → show the full `full_log` JSON expanded in structured form

### 5.3 Acceptance test

- [ ] `tests/admin-install-check.test.js` (new file): mock two records (one pass, one fail) → confirm list + detail view are correct

---

## 6. Verification (superpowers:verification-before-completion)

- [ ] 7 reproduction tests all green
- [ ] Existing 60+ tests all green (no regression allowed)
- [ ] Run `npm run lint` with no warnings
- [ ] **Manual test**: on a Windows VM (or Alice's machine) run `bootstrap.ps1` to upgrade to this version
  - Expected: upgrade OK, no popup windows, self-check uploads successfully, upgrade_trace written
- [ ] **Manual test**: unplug power (battery mode) → wait 2 hours → scanner doesn't run
- [ ] **Manual test**: deliberately set the API key wrong → self-check uploads 401 → check the spool has a write
  - Set the correct key back → re-run self-check → spool emptied, server received the old records

---

## 7. Code review (superpowers:requesting-code-review)

- [ ] Run the diff once through the codex/code-reviewer agent
- [ ] Key questions:
  - Will the VBS launcher be false-killed in an enterprise antivirus environment?
  - Is safeSpawn's default-override logic too lax?
  - Does the spool mechanism have a race condition (two self-checks running at once)?
  - Does the admin install-check view have a PII leak risk?
- [ ] After receiving the review go through superpowers:receiving-code-review, **no blind changes**

---

## 8. Tri-sync (IR-008) + three version numbers (IR-031) + tri-lingual README (IR-032)

### 8.1 Sync three version numbers to 1.17.66

- [ ] `package.json` `"version": "1.17.66"`
- [ ] `mcp/index.js` SERVER_VERSION constant (if any)
- [ ] git tag `v1.17.66` (tagged at commit time)

### 8.2 README tri-lingual

- [ ] `README.md` (zh-TW) — add a "v1.17.66 Windows platform hardening" section
- [ ] `README.en.md` (if it exists)
- [ ] `README.ja.md` (if it exists)

### 8.3 CHANGELOG.md

- [ ] Add a v1.17.66 entry, following the existing format
- [ ] List the seven bug fixes + environment info collection + admin view + three helpers

### 8.4 FILELIST.md

- [ ] Add entries:
  - `scripts/windows/lib/find-git-bash.ps1`
  - `scripts/windows/run-hidden.vbs`
  - `scripts/install-helpers/safe-spawn.cjs`
  - `scripts/install-helpers/path-to-win32.cjs`
  - `scripts/install-helpers/check-file-locks.cjs`
  - `openspec/changes/v1.17.66-windows-hardening/*.md`

---

## 9. Commit + PR

- [ ] Follow IR-009: contributors show Vin
- [ ] Follow IR-024: commit message has no `Co-Authored-By`
- [ ] commit message format aligned with existing: `feat(windows): v1.17.66 Windows platform hardening + IR-038 observability pipeline extension`
- [ ] PR description includes: the seven-bug list + fix summary + a "please re-run bootstrap" note for Alice/Bob

---

## 10. Wrap-up

- [ ] `ownmind_save` the IR-038 candidate iron rule into cloud memory
- [ ] Notify Alice / Bob to upgrade
- [ ] Note: start pulling install_check_logs 24~48h after v1.17.66 deploys, see if any new bug surfaces → plan v1.17.67 (fix #3 + #5)

---

## Enforced dependency graph

```
[0] Alice screenshot verifies #7
       ↓
[1] Helpers (1.1 ~ 1.4) ← must be built first
       ↓
[2] Reproduction tests (fail first)
       ↓
[3] Fix bugs (#1, #2, #4, #6, #7-a, #7-b) (after each commit, run the corresponding test and turn it green)
       ↓
[4] Environment info collection extension
       ↓
[5] Admin view
       ↓
[6] verification-before-completion (run everything once)
       ↓
[7] requesting-code-review
       ↓
[8] Tri-sync + three version numbers + tri-lingual README
       ↓
[9] Commit + PR
       ↓
[10] Wrap-up
```

**No skipping stages.** A stage must pass before entering the next (IR-007 Persistent Bug Protocol + the software-development quality gates).
