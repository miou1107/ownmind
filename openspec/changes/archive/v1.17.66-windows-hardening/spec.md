# v1.17.66 — Spec

Formal spec and acceptance criteria. Each change is described in GIVEN/WHEN/THEN form.

---

## 1. Helper API contracts

### 1.1 `scripts/windows/lib/find-git-bash.ps1`

```powershell
# Find-GitBash — find a usable Git Bash executable, avoiding the WSL relay
#
# Returns: full path (string), or $null if not found
#
# Detection order:
#   1. ~/.ownmind/.git-bash-path cache (if it exists and the file is still there)
#   2. common paths:
#      - $env:ProgramFiles\Git\bin\bash.exe
#      - ${env:ProgramFiles(x86)}\Git\bin\bash.exe
#      - $env:LOCALAPPDATA\Programs\Git\bin\bash.exe
#   3. where.exe bash result, filtering out C:\Windows\System32\bash.exe (WSL relay)
#   4. none found → return $null
#
# After finding:
#   - use `bash --version` to confirm it really is Git Bash (containing "Microsoft Corporation" means WSL → skip)
#   - write cache to ~/.ownmind/.git-bash-path
function Find-GitBash { ... }
```

**Acceptance:**

- **GIVEN** a Windows environment with only `C:\Windows\System32\bash.exe` (WSL relay) and `C:\Program Files\Git\bin\bash.exe`
- **WHEN** calling `Find-GitBash`
- **THEN** returns `C:\Program Files\Git\bin\bash.exe`, **not** the System32 one

- **GIVEN** a Windows environment with only `C:\Windows\System32\bash.exe` (no Git Bash installed)
- **WHEN** calling `Find-GitBash`
- **THEN** returns `$null`, and logs a warning: "Git Bash not found, please install https://git-scm.com/"

### 1.2 `scripts/install-helpers/safe-spawn.cjs`

```js
/**
 * safeSpawn — a Windows-friendly wrapper around execFile
 *
 * Defaults (overridable via options, but logs a warning):
 *   - shell: false      (never go through a shell — on Windows cmd interprets |)
 *   - windowsHide: true (never show a console window)
 *   - timeout: 5000ms
 *
 * Extra features:
 *   - auto-sanitize stderr/stdout (strip $HOME paths)
 *   - on failure returns { ok: false, error, code, stderr_tail } instead of throwing
 */
async function safeSpawn(file, args, options = {}) { ... }
```

**Acceptance:**

- **GIVEN** on Windows `safeSpawn('powershell.exe', ['-Command', 'echo a | findstr a'])`
- **WHEN** called
- **THEN** PowerShell receives the full string `echo a | findstr a` and interprets `|` itself, **not** via cmd.exe

- **GIVEN** any `safeSpawn` call
- **WHEN** it runs
- **THEN** no console window opens (even for a console-subsystem binary)

### 1.3 `scripts/install-helpers/path-to-win32.cjs`

```js
/**
 * toWin32Path — MSYS path → Win32 path
 *
 * /c/Users/X/.ownmind  → C:\Users\X\.ownmind
 * C:\already\win32     → C:\already\win32 (returned as-is)
 * /Users/x/foo (macOS) → /Users/x/foo (untouched on non-Windows)
 */
function toWin32Path(p) { ... }
```

**Acceptance:**

- **GIVEN** Git Bash provides `$HOME = /c/Users/Bob`
- **WHEN** `toWin32Path(homedir())`
- **THEN** returns `C:\Users\Bob` (used to feed `node -p require(...)`)

### 1.4 `scripts/windows/run-hidden.vbs`

```vbs
' run-hidden.vbs — run the following command hidden, in the background
' Usage: wscript.exe run-hidden.vbs <executable> [args...]
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next
sh.Run Trim(cmd), 0, False   ' 0 = SW_HIDE, False = do not wait for return
```

**Acceptance:**

- **GIVEN** Task Scheduler runs `wscript.exe run-hidden.vbs node.exe scanner.js`
- **WHEN** the trigger fires
- **THEN** no console window appears at all (regardless of console-subsystem binaries like `node.exe`, `cmd.exe`)

---

## 2. Bug fix acceptance criteria

### 2.1 Bug #1 — interactive-upgrade.ps1 no longer uses bare `bash`

**Before** (line 120, 125, 130):
```powershell
bash $verifyScript --local 2>&1 | Out-File -Append $LogFile
```

**After**:
```powershell
. (Join-Path $OwnMindDir 'scripts\windows\lib\find-git-bash.ps1')
$BashExe = Find-GitBash
if (-not $BashExe) {
  Step "no_git_bash" "找不到 Git Bash，跳過 verify_local（不擋升級）"
} else {
  & $BashExe $verifyScript --local 2>&1 | Out-File -Append $LogFile -Encoding utf8
}
```

**Acceptance:**

- **GIVEN** the user runs `bootstrap.ps1` to upgrade on Windows
- **WHEN** reaching the verify_local stage
- **THEN** verify-upgrade.sh runs via Git Bash and the `<3>WSL ... execvpe failed` error is **not** seen

- **GIVEN** the user has no Git Bash installed
- **WHEN** reaching the verify_local stage
- **THEN** verify is skipped but the upgrade is **not blocked**; a warning is logged and self-check upload continues

### 2.2 Bug #2 — self-check.cjs scheduler removes `shell:true`

**Before** (self-check.cjs:195-197):
```js
const { stdout } = await execFileAsync('powershell.exe',
  ['-NoProfile', '-Command', "Get-ScheduledTask ... | Select-Object ..."],
  { timeout: TIMEOUT_MS, shell: true });
```

**After** (using safeSpawn):
```js
const { stdout } = await safeSpawn('powershell.exe',
  ['-NoProfile', '-Command', "Get-ScheduledTask -TaskName 'OwnMind Usage Scanner' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty State"]);
```

**Acceptance:**

- **GIVEN** Task Scheduler on Windows really has the `OwnMind Usage Scanner` task with state=Ready
- **WHEN** self-check runs `checkScheduler`
- **THEN** returns `pass('scheduler', 'Task Scheduler state=Ready')`

- **GIVEN** Task Scheduler **does not have** `OwnMind Usage Scanner`
- **WHEN** self-check runs `checkScheduler`
- **THEN** returns `fail('scheduler', 'Task Scheduler 找不到...')`, **not** the false positive of `Select-Object` not being found

### 2.3 Bug #4 — self-check observability pipeline guaranteed to run + failure spool

**interactive-upgrade.ps1 change**:

Change self-check from "only run on upgrade success" at line 172 to a try/finally structure:

```powershell
$selfCheckRan = $false
try {
  # ... the original upgrade flow (verify, dismiss broadcast, etc.) ...
  OK "done" "升級完成 → 版本：$Version"
}
finally {
  # Regardless of upgrade success or failure, self-check must run (observability IR-038)
  if (-not $selfCheckRan -and (Test-Path $SelfCheckScript)) {
    try {
      & node $SelfCheckScript --trigger=post_upgrade
      $selfCheckRan = $true
    } catch {
      # self-check crashing itself must not affect the upper-level exit code
    }
  }
}
```

**self-check.cjs uploadReport change**:

Add a spool mechanism:

```js
const SPOOL_FILE = path.join(OWNMIND_DIR, 'logs', '.upload-spool.jsonl');

async function uploadReport(report, apiUrl, apiKey) {
  // First try to re-send the old reports in the spool
  await retrySpool(apiUrl, apiKey);

  // Then send this one
  if (fs.existsSync(NO_UPLOAD_FLAG)) return { skipped: true, reason: 'opt_out_flag' };
  if (!apiUrl || !apiKey) {
    appendSpool(report);   // no credentials, so store it for now
    return { skipped: true, reason: 'no_credentials_spooled' };
  }
  try {
    const r = await fetchWithTimeout(...);
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) {
      appendSpool(report);   // auth broken, store it; re-send after the user resets the key
      return { ok: false, status: r.status, spooled: true };
    }
    appendSpool(report);
    return { ok: false, status: r.status, spooled: true };
  } catch (e) {
    appendSpool(report);
    return { ok: false, error: sanitizePath(e.message), spooled: true };
  }
}
```

**Acceptance:**

- **GIVEN** the upgrade hits a verify_local failure
- **WHEN** interactive-upgrade.ps1 ends
- **THEN** self-check.cjs is still called, and the server receives `trigger=post_upgrade` + failure evidence

- **GIVEN** API key 401 (like Bob's case)
- **WHEN** self-check attempts upload
- **THEN** the report is written to `~/.ownmind/logs/.upload-spool.jsonl`, and the console prints "上傳：暫存（待重試）"

- **GIVEN** the spool file has old reports, and the user re-runs bootstrap with a new key then runs self-check again
- **WHEN** self-check starts
- **THEN** it first re-sends all spool contents (deleting spool lines on success), then sends this one

### 2.4 Bug #6 — add `-Encoding utf8` to all Out-File

**Grep scope**: all `*.ps1` files.

**Change rules**:
- `Out-File ...` → `Out-File ... -Encoding utf8`
- `Set-Content ...` → `Set-Content ... -Encoding utf8`
- `Add-Content ...` → `Add-Content ... -Encoding utf8`

**Acceptance:**

- **GIVEN** the full upgrade flow runs on Windows
- **WHEN** reading `~/.ownmind/logs/upgrade-*.log`
- **THEN** Chinese displays correctly when decoded as UTF-8, with no 0x00 NUL characters and no BOM prefix

### 2.5 Bug #7-a — Scanner task uses a VBS launcher to hide windows

**register-scanner-task.ps1 change**:

```powershell
# Before:
$Action = New-ScheduledTaskAction `
  -Execute $NodeBin `
  -Argument "`"$ScannerJs`""

# After:
$VbsLauncher = Join-Path $OwnMindDir 'scripts\windows\run-hidden.vbs'
$Action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "`"$VbsLauncher`" `"$NodeBin`" `"$ScannerJs`""
```

**Acceptance:**

- **GIVEN** Task Scheduler triggers `OwnMind Usage Scanner`
- **WHEN** the task starts executing
- **THEN** the screen flashes **no** console / PowerShell window at all

- **GIVEN** after the task finishes
- **WHEN** looking at `~/.ownmind/logs/scanner-*.log`
- **THEN** the scanner really ran and the log was written normally

### 2.6 Bug #7-b — Scanner task settings add battery + frequency

**register-scanner-task.ps1 change**:

```powershell
# Before (line 89-98):
$Trigger = New-ScheduledTaskTrigger `
  -Once -At (Get-Date).AddMinutes(5) `
  -RepetitionInterval (New-TimeSpan -Minutes 30) `
  -RepetitionDuration (New-TimeSpan -Days 9999)
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

# After:
$Trigger = New-ScheduledTaskTrigger `
  -Once -At (Get-Date).AddMinutes(5) `
  -RepetitionInterval (New-TimeSpan -Minutes 120) `
  -RepetitionDuration (New-TimeSpan -Days 9999)
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable -DontStopOnIdleEnd `
  -DontStartIfOnBatteries `
  -StopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
# Note: WakeToRun defaults to false, not written explicitly
```

**Acceptance:**

- **GIVEN** the laptop is unplugged (battery mode)
- **WHEN** the task trigger time arrives
- **THEN** the task **does not run**; it catches up at the next trigger after being plugged in

- **GIVEN** the user unplugs power mid-task
- **WHEN** entering battery mode
- **THEN** the task stops immediately

- **GIVEN** within 24 hours
- **WHEN** counting task trigger occurrences
- **THEN** ≤ 12 times (once every 2 hours), compared to the old 48 times / 24 hours

---

## 3. Environment info collection schema (IR-038 implementation)

### 3.1 `install_check_logs.full_log` JSON extension

```ts
type InstallCheckFullLog = {
  // existing fields (since v1.17.63)
  ts: string;
  trigger: 'post_install' | 'post_upgrade' | 'manual' | 'manual_after_failure';
  client_version: string;
  platform: 'win32' | 'darwin' | 'linux';
  node_version: string;
  machine: string;
  checks: Array<{ name: string; status: 'pass'|'warn'|'fail'; detail: string; fix?: string }>;
  summary: { pass: number; warn: number; fail: number };

  // added in v1.17.66
  env: {
    os_release: string;                              // os.release()
    arch: string;                                    // os.arch()

    // shell / process chain
    shell_chain: string[];                           // ['powershell.exe', 'wscript.exe', 'node.exe']

    // bash detection (Windows)
    bash_resolution: {
      where_results: string[];                       // ["C:\\Windows\\System32\\bash.exe", ...]
      selected: 'WSL_RELAY' | 'GIT_BASH' | 'WSL_DISTRO' | 'NOT_FOUND';
      git_bash_path: string | null;
    } | null;                                        // null on non-Windows

    // node environment
    node: {
      exec_path: string;                             // process.execPath (returns only basename + whether native)
      version: string;
    };

    // path / encoding
    home_format: {
      value: string;                                 // sanitized ~
      is_msys: boolean;                              // starts with / or C:\
    };
    msystem: string | null;                          // process.env.MSYSTEM
    encoding: {
      lang: string;                                  // process.env.LANG / LC_ALL
      console_codepage: string | null;               // chcp (Windows)
      default_outfile_encoding: string | null;       // PS detection (Windows)
    };

    // task scheduler real state (Windows)
    scheduler_detail: {
      task_name: string;
      state: string;                                 // Ready / Running / Disabled
      last_run_time: string | null;
      last_task_result: string | null;               // hex code
      next_run_time: string | null;
    } | null;
  };

  // upgrade trace (only present when trigger=post_upgrade)
  upgrade_trace?: Array<{
    step: string;                                    // git_pull / npm_install / install / reschedule / verify_local / ...
    status: 'ok' | 'fail' | 'skipped';
    duration_ms: number;
    stderr_tail?: string;                            // last 500 characters
  }>;

  // file lock detection (Windows, only present when trigger=manual_after_failure or rollback failed)
  file_locks?: Array<{
    path: string;
    held_by: string;                                 // 'node.exe (PID 12345)' or 'unknown'
  }>;
};
```

**Size estimate**: ~3KB baseline, ~5KB with upgrade_trace, ~6KB with file_locks. Far below the 64KB server limit.

### 3.2 PII handling

- `machine`: keep hostname (existing precedent, admin needs it)
- `home_format.value`: use `sanitizePath` to replace `$HOME` with `~`
- `bash_resolution.where_results`: keep full path (without username)
- `path` in file_locks: use `sanitizePath`
- do not send the full `process.env.PATH` (security, too large)

### 3.3 Acceptance

- **GIVEN** an upgrade failure on either Alice's or Bob's machine
- **WHEN** self-check.cjs uploads
- **THEN** the server `install_check_logs.full_log` contains `env.bash_resolution.selected = 'WSL_RELAY'`, and the admin can spot the root cause at a glance on the dashboard

- **GIVEN** any user runs self-check
- **WHEN** looking at the `full_log` JSON
- **THEN** there is no absolute home path, no full PATH, no API key

---

## 4. Admin dashboard view spec

### 4.1 Route: `/ownmind/admin/install-check`

Visible to the super_admin role only.

### 4.2 List view

- Defaults to the last 7 days, all users × last 5 records
- Columns: user / time / client version / platform / trigger / pass-warn-fail counts / action
- Filters: trigger=post_upgrade only / only those with a fail / a specific user
- Sort: by time descending (default)

### 4.3 Detail view

Click a row → modal shows:

- 7 check results (with fix suggestions)
- env section (shell_chain, bash_resolution, etc.)
- upgrade_trace (if present) — as a timeline + failure highlight
- file_locks (if present)

### 4.4 Acceptance

- **GIVEN** Alice's upgrade failed and self-check uploaded
- **WHEN** the admin opens `/ownmind/admin/install-check` and finds Alice's record
- **THEN** they see "scheduler fail (Select-Object not found)" + the env section shows `bash_resolution.selected=WSL_RELAY`, allowing the fix to be determined directly

---

## 5. Test strategy

The detailed test list is in [tasks.md](./tasks.md) §3. Each bug corresponds to one reproduction test, added to the existing `tests/ps1-windows-compat.test.js` and `tests/self-check.test.js`, **not** new test files.

Before implementation, each reproduction test must **fail first** (reproducing the bug); after the fix it must **turn green**. No "write the test after it's green" in between (IR-003).
