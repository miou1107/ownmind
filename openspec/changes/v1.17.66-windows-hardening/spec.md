# v1.17.66 — Spec

正式規格與 acceptance criteria。每個改動都用 GIVEN/WHEN/THEN 三段式描述。

---

## 1. Helper API contracts

### 1.1 `scripts/windows/lib/find-git-bash.ps1`

```powershell
# Find-GitBash — 找出可用的 Git Bash 執行檔，避開 WSL relay
#
# 回傳：完整路徑（string），或 $null 如找不到
#
# 偵測順序：
#   1. ~/.ownmind/.git-bash-path cache（若存在且檔案還在）
#   2. 常見路徑：
#      - $env:ProgramFiles\Git\bin\bash.exe
#      - ${env:ProgramFiles(x86)}\Git\bin\bash.exe
#      - $env:LOCALAPPDATA\Programs\Git\bin\bash.exe
#   3. where.exe bash 結果，過濾掉 C:\Windows\System32\bash.exe（WSL relay）
#   4. 都找不到 → 回 $null
#
# 找到後：
#   - 用 `bash --version` 確認真的是 Git Bash（含 "Microsoft Corporation" 字串代表 WSL → 跳過）
#   - 寫 cache 到 ~/.ownmind/.git-bash-path
function Find-GitBash { ... }
```

**Acceptance：**

- **GIVEN** Windows 環境只有 `C:\Windows\System32\bash.exe`（WSL relay）和 `C:\Program Files\Git\bin\bash.exe`
- **WHEN** 呼叫 `Find-GitBash`
- **THEN** 回傳 `C:\Program Files\Git\bin\bash.exe`，**不**回 System32 的

- **GIVEN** Windows 環境只有 `C:\Windows\System32\bash.exe`（沒裝 Git Bash）
- **WHEN** 呼叫 `Find-GitBash`
- **THEN** 回傳 `$null`，並 log warning：「找不到 Git Bash，請安裝 https://git-scm.com/」

### 1.2 `scripts/install-helpers/safe-spawn.cjs`

```js
/**
 * safeSpawn — execFile 的 Windows-friendly 包裝
 *
 * 預設值（可被 options override，但會 log warning）：
 *   - shell: false      （絕不過 shell — Windows 上會被 cmd 解 |）
 *   - windowsHide: true （絕不顯示 console window）
 *   - timeout: 5000ms
 *
 * 額外功能：
 *   - 自動 sanitize stderr/stdout（去掉 $HOME 路徑）
 *   - 失敗回 { ok: false, error, code, stderr_tail } 而非 throw
 */
async function safeSpawn(file, args, options = {}) { ... }
```

**Acceptance：**

- **GIVEN** 在 Windows 上 `safeSpawn('powershell.exe', ['-Command', 'echo a | findstr a'])`
- **WHEN** 呼叫
- **THEN** PowerShell 接到完整字串 `echo a | findstr a` 並由 PowerShell 自己解 `|`，**不**經 cmd.exe

- **GIVEN** `safeSpawn` 任何呼叫
- **WHEN** 跑起來
- **THEN** 不開任何 console window（即使是 console subsystem binary）

### 1.3 `scripts/install-helpers/path-to-win32.cjs`

```js
/**
 * toWin32Path — MSYS path → Win32 path
 *
 * /c/Users/X/.ownmind  → C:\Users\X\.ownmind
 * C:\already\win32     → C:\already\win32（直接回）
 * /Users/x/foo (macOS) → /Users/x/foo（非 Windows 不動）
 */
function toWin32Path(p) { ... }
```

**Acceptance：**

- **GIVEN** Git Bash 給的 `$HOME = /c/Users/Adam`
- **WHEN** `toWin32Path(homedir())`
- **THEN** 回 `C:\Users\Adam`（用於餵 `node -p require(...)`）

### 1.4 `scripts/windows/run-hidden.vbs`

```vbs
' run-hidden.vbs — 把後面的命令隱藏視窗背景跑
' 用法：wscript.exe run-hidden.vbs <executable> [args...]
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next
sh.Run Trim(cmd), 0, False   ' 0 = SW_HIDE，False = 不等待回傳
```

**Acceptance：**

- **GIVEN** Task Scheduler 跑 `wscript.exe run-hidden.vbs node.exe scanner.js`
- **WHEN** trigger 觸發
- **THEN** 完全沒有任何 console window 出現（不論 console subsystem binary 如 `node.exe`、`cmd.exe`）

---

## 2. Bug 修法 acceptance criteria

### 2.1 Bug #1 — interactive-upgrade.ps1 不再 bare `bash`

**修改前**（line 120, 125, 130）：
```powershell
bash $verifyScript --local 2>&1 | Out-File -Append $LogFile
```

**修改後**：
```powershell
. (Join-Path $OwnMindDir 'scripts\windows\lib\find-git-bash.ps1')
$BashExe = Find-GitBash
if (-not $BashExe) {
  Step "no_git_bash" "找不到 Git Bash，跳過 verify_local（不擋升級）"
} else {
  & $BashExe $verifyScript --local 2>&1 | Out-File -Append $LogFile -Encoding utf8
}
```

**Acceptance：**

- **GIVEN** 使用者在 Windows 跑 `bootstrap.ps1` 升級
- **WHEN** 走到 verify_local 階段
- **THEN** 用 Git Bash 跑 verify-upgrade.sh，**不**會看到 `<3>WSL ... execvpe failed` 錯誤

- **GIVEN** 使用者沒裝 Git Bash
- **WHEN** 走到 verify_local 階段
- **THEN** 跳過 verify 但**不擋升級**，記 warning，繼續往下做 self-check 上傳

### 2.2 Bug #2 — self-check.cjs scheduler 拿掉 `shell:true`

**修改前**（self-check.cjs:195-197）：
```js
const { stdout } = await execFileAsync('powershell.exe',
  ['-NoProfile', '-Command', "Get-ScheduledTask ... | Select-Object ..."],
  { timeout: TIMEOUT_MS, shell: true });
```

**修改後**（用 safeSpawn）：
```js
const { stdout } = await safeSpawn('powershell.exe',
  ['-NoProfile', '-Command', "Get-ScheduledTask -TaskName 'OwnMind Usage Scanner' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty State"]);
```

**Acceptance：**

- **GIVEN** Windows 上 Task Scheduler 確實有 `OwnMind Usage Scanner` task 且 state=Ready
- **WHEN** self-check 跑 `checkScheduler`
- **THEN** 回 `pass('scheduler', 'Task Scheduler state=Ready')`

- **GIVEN** Task Scheduler **沒有** `OwnMind Usage Scanner`
- **WHEN** self-check 跑 `checkScheduler`
- **THEN** 回 `fail('scheduler', 'Task Scheduler 找不到...')`，**不**回 `Select-Object` 找不到的偽陽性

### 2.3 Bug #4 — self-check 觀測管道保證執行 + 失敗 spool

**interactive-upgrade.ps1 修改**：

把 self-check 從 line 172 的「升級成功才跑」改成 try/finally 結構：

```powershell
$selfCheckRan = $false
try {
  # ... 原本的升級流程 (verify, dismiss broadcast, 等等) ...
  OK "done" "升級完成 → 版本：$Version"
}
finally {
  # 不論升級成功失敗，self-check 一定要跑（觀測 IR-038）
  if (-not $selfCheckRan -and (Test-Path $SelfCheckScript)) {
    try {
      & node $SelfCheckScript --trigger=post_upgrade
      $selfCheckRan = $true
    } catch {
      # self-check 自己 crash 不能影響上層 exit code
    }
  }
}
```

**self-check.cjs uploadReport 修改**：

新增 spool 機制：

```js
const SPOOL_FILE = path.join(OWNMIND_DIR, 'logs', '.upload-spool.jsonl');

async function uploadReport(report, apiUrl, apiKey) {
  // 先嘗試補傳 spool 裡的舊報告
  await retrySpool(apiUrl, apiKey);

  // 再傳這次的
  if (fs.existsSync(NO_UPLOAD_FLAG)) return { skipped: true, reason: 'opt_out_flag' };
  if (!apiUrl || !apiKey) {
    appendSpool(report);   // 沒 credentials 就先存
    return { skipped: true, reason: 'no_credentials_spooled' };
  }
  try {
    const r = await fetchWithTimeout(...);
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) {
      appendSpool(report);   // auth 壞掉先存著，下次 user 重設 key 後補傳
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

**Acceptance：**

- **GIVEN** 升級走到 verify_local 失敗
- **WHEN** interactive-upgrade.ps1 結束
- **THEN** self-check.cjs 仍被呼叫，server 收到 `trigger=post_upgrade` + 失敗證據

- **GIVEN** API key 401（如 Adam 案例）
- **WHEN** self-check 嘗試上傳
- **THEN** 報告寫進 `~/.ownmind/logs/.upload-spool.jsonl`，console 印「上傳：暫存（待重試）」

- **GIVEN** spool 檔有舊報告，user 重跑 bootstrap 換新 key 後再跑 self-check
- **WHEN** self-check 開始
- **THEN** 先補傳所有 spool 內容（成功則刪 spool 行），再傳這次的

### 2.4 Bug #6 — 全部 Out-File 加 `-Encoding utf8`

**Grep 範圍**：所有 `*.ps1` 檔案。

**修改規則**：
- `Out-File ...` → `Out-File ... -Encoding utf8`
- `Set-Content ...` → `Set-Content ... -Encoding utf8`
- `Add-Content ...` → `Add-Content ... -Encoding utf8`

**Acceptance：**

- **GIVEN** Windows 跑完整升級流程
- **WHEN** 讀 `~/.ownmind/logs/upgrade-*.log`
- **THEN** 用 UTF-8 解碼正確顯示中文，沒有 0x00 NUL 字元、沒有 BOM 前綴

### 2.5 Bug #7-a — Scanner task 用 VBS launcher 隱藏視窗

**register-scanner-task.ps1 修改**：

```powershell
# 改前：
$Action = New-ScheduledTaskAction `
  -Execute $NodeBin `
  -Argument "`"$ScannerJs`""

# 改後：
$VbsLauncher = Join-Path $OwnMindDir 'scripts\windows\run-hidden.vbs'
$Action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "`"$VbsLauncher`" `"$NodeBin`" `"$ScannerJs`""
```

**Acceptance：**

- **GIVEN** Task Scheduler 觸發 `OwnMind Usage Scanner`
- **WHEN** task 開始執行
- **THEN** 螢幕**完全不**閃任何 console / PowerShell window

- **GIVEN** task 跑完後
- **WHEN** 看 `~/.ownmind/logs/scanner-*.log`
- **THEN** scanner 確實有跑、log 正常寫入

### 2.6 Bug #7-b — Scanner task settings 加 battery + 頻率

**register-scanner-task.ps1 修改**：

```powershell
# 改前（line 89-98）：
$Trigger = New-ScheduledTaskTrigger `
  -Once -At (Get-Date).AddMinutes(5) `
  -RepetitionInterval (New-TimeSpan -Minutes 30) `
  -RepetitionDuration (New-TimeSpan -Days 9999)
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

# 改後：
$Trigger = New-ScheduledTaskTrigger `
  -Once -At (Get-Date).AddMinutes(5) `
  -RepetitionInterval (New-TimeSpan -Minutes 120) `
  -RepetitionDuration (New-TimeSpan -Days 9999)
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable -DontStopOnIdleEnd `
  -DontStartIfOnBatteries `
  -StopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
# 注意：WakeToRun 預設 false，不顯式寫
```

**Acceptance：**

- **GIVEN** 筆電拔電源（電池模式）
- **WHEN** task trigger 時間到
- **THEN** task **不執行**；接電源後下一次 trigger 才補跑

- **GIVEN** task 跑到一半 user 拔電源
- **WHEN** 進入電池模式
- **THEN** task 立即停止

- **GIVEN** 24 小時內
- **WHEN** 統計 task 觸發次數
- **THEN** ≤ 12 次（每 2 小時一次），對比舊版 48 次 / 24 小時

---

## 3. 環境資訊收集 schema（IR-038 落實）

### 3.1 `install_check_logs.full_log` JSON 擴充

```ts
type InstallCheckFullLog = {
  // 既有欄位（v1.17.63 已有）
  ts: string;
  trigger: 'post_install' | 'post_upgrade' | 'manual' | 'manual_after_failure';
  client_version: string;
  platform: 'win32' | 'darwin' | 'linux';
  node_version: string;
  machine: string;
  checks: Array<{ name: string; status: 'pass'|'warn'|'fail'; detail: string; fix?: string }>;
  summary: { pass: number; warn: number; fail: number };

  // v1.17.66 新增
  env: {
    os_release: string;                              // os.release()
    arch: string;                                    // os.arch()

    // shell / process chain
    shell_chain: string[];                           // ['powershell.exe', 'wscript.exe', 'node.exe']

    // bash 偵測（Windows）
    bash_resolution: {
      where_results: string[];                       // ["C:\\Windows\\System32\\bash.exe", ...]
      selected: 'WSL_RELAY' | 'GIT_BASH' | 'WSL_DISTRO' | 'NOT_FOUND';
      git_bash_path: string | null;
    } | null;                                        // 非 Windows 為 null

    // node 環境
    node: {
      exec_path: string;                             // process.execPath（只回 basename + 是否 native）
      version: string;
    };

    // path / encoding
    home_format: {
      value: string;                                 // sanitize 過的 ~
      is_msys: boolean;                              // 開頭是 / 還是 C:\
    };
    msystem: string | null;                          // process.env.MSYSTEM
    encoding: {
      lang: string;                                  // process.env.LANG / LC_ALL
      console_codepage: string | null;               // chcp（Windows）
      default_outfile_encoding: string | null;       // PS 偵測（Windows）
    };

    // task scheduler 真實狀態（Windows）
    scheduler_detail: {
      task_name: string;
      state: string;                                 // Ready / Running / Disabled
      last_run_time: string | null;
      last_task_result: string | null;               // hex code
      next_run_time: string | null;
    } | null;
  };

  // 升級 trace（只在 trigger=post_upgrade 有）
  upgrade_trace?: Array<{
    step: string;                                    // git_pull / npm_install / install / reschedule / verify_local / ...
    status: 'ok' | 'fail' | 'skipped';
    duration_ms: number;
    stderr_tail?: string;                            // 最後 500 字元
  }>;

  // file lock 偵測（Windows，只在 trigger=manual_after_failure 或 rollback 失敗有）
  file_locks?: Array<{
    path: string;
    held_by: string;                                 // 'node.exe (PID 12345)' or 'unknown'
  }>;
};
```

**大小估算**：基本 ~3KB，含 upgrade_trace ~5KB，含 file_locks ~6KB。遠低於 64KB server 上限。

### 3.2 PII 處理

- `machine`：保留 hostname（已有先例，admin 需要）
- `home_format.value`：用 `sanitizePath` 把 `$HOME` 換成 `~`
- `bash_resolution.where_results`：保留完整路徑（不含使用者名）
- `path` in file_locks：用 `sanitizePath`
- 不傳 `process.env.PATH` 全文（資安、太大）

### 3.3 Acceptance

- **GIVEN** Eric / Adam 任一台升級失敗
- **WHEN** self-check.cjs 上傳
- **THEN** server `install_check_logs.full_log` 含 `env.bash_resolution.selected = 'WSL_RELAY'`，admin 看 dashboard 一眼看出根因

- **GIVEN** 任何使用者跑 self-check
- **WHEN** 看 `full_log` JSON
- **THEN** 沒有 absolute home path、沒有完整 PATH、沒有 API key

---

## 4. Admin dashboard view spec

### 4.1 路由：`/ownmind/admin/install-check`

只開 super_admin role 看。

### 4.2 列表 view

- 預設顯示最近 7 天，所有 user × 最近 5 次紀錄
- 欄：使用者 / 時間 / 客戶端版本 / 平台 / trigger / pass-warn-fail 數 / 動作
- 篩選：trigger=post_upgrade only / 只看含 fail 的 / 特定 user
- 排序：時間倒序（預設）

### 4.3 詳細 view

點某筆 → modal 顯示：

- 7 個 check 結果（含 fix 建議）
- env section（shell_chain、bash_resolution 等）
- upgrade_trace（如果有）— 用時間軸 + 失敗高亮
- file_locks（如果有）

### 4.4 Acceptance

- **GIVEN** Eric 升級失敗，self-check 已上傳
- **WHEN** admin 開 `/ownmind/admin/install-check` 找 Eric 的紀錄
- **THEN** 看到「scheduler fail（Select-Object 找不到）」+ env 區塊顯示 `bash_resolution.selected=WSL_RELAY`，可直接判斷修法

---

## 5. 測試策略

詳細測試清單在 [tasks.md](./tasks.md) §3。每個 bug 對應一條 reproduction test，加進既有 `tests/ps1-windows-compat.test.js` 和 `tests/self-check.test.js`，**不**新建測試檔。

實作前 reproduction test 必須**先紅**（重現 bug）；修完後**轉綠**。中間不允許「綠了再寫 test」（IR-003）。
