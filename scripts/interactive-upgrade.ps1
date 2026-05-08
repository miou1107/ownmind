# OwnMind 互動式升級 script — Windows PowerShell (v1.17.0 P5, v1.17.66 hardened)
#
# 用法：powershell -ExecutionPolicy Bypass -File ~/.ownmind/scripts/interactive-upgrade.ps1
# stdout 格式與 bash 版相同（INFO / OK / ERROR / ASK 前綴）
#
# v1.17.66 變更（Eric / Adam Windows 升級失敗劇本）：
#   1. 三處 bash 改走 Find-GitBash helper（避開 System32\bash.exe WSL relay）
#   2. 所有 Out-File / 重導向加 -Encoding utf8（避免 UTF-16 BOM 中文 garbled）
#   3. 流程包進 try/finally，self-check.cjs 觀測在 finally 區塊保證執行（IR-038）
#   4. verify_local 失敗不再連帶 Rollback — verify 是事後體檢，不擋升級

Set-StrictMode -Version Latest
Set-ExecutionPolicy -Scope Process Bypass -Force -ErrorAction SilentlyContinue

# 環境正規化（v1.17.9, 回報者 Adam）— Git Bash / MSYS 會把 $HOME 污染成 /c/Users/xxx
if ($env:USERPROFILE -and ($HOME -ne $env:USERPROFILE)) {
  Set-Variable -Name HOME -Value $env:USERPROFILE -Force -Scope Global -ErrorAction SilentlyContinue
}

$OwnMindDir = Join-Path $HOME ".ownmind"
$Ts = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDir = Join-Path $HOME ".ownmind.bak.$Ts"
$LogDir = Join-Path $OwnMindDir "logs"
$LogFile = Join-Path $LogDir "upgrade-$Ts.log"

function Step($code, $msg) { Write-Host "INFO:${code}:$msg" }
function OK($code, $msg)   { Write-Host "OK:${code}:$msg" }
# v1.17.66 review fix — Fail 改成 throw（不直接 exit）。
# 為什麼：PowerShell 5.1/7.x 在 try block 內遇到 `exit` 時，finally 不一定會跑
# （MS docs 說會跑，但實測有 bug 報告）。改成 throw + 外層 catch + finally
# 確保 self-check 觀測一定執行（IR-038）。
function Fail($code, $msg) { throw "ERROR:${code}:$msg" }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# v1.17.79 — 載入 report-error helper（IR-038）
$reportErrorHelper = Join-Path $OwnMindDir 'scripts\install-helpers\report-error.ps1'
if (Test-Path $reportErrorHelper) {
  . $reportErrorHelper
} else {
  function Report-Error { param($Kind, $Detail, $ContextFile = "") }
}

# v1.17.84 — Windows file-lock detection（vin-windows-test 第七輪）
# OwnMind MCP node process 持有 ~/.ownmind/mcp/node_modules/*.js handle 時，
# git pull / npm install 會吃 EBUSY / EACCES。掃 log 找 lock pattern，中了就改錯誤碼為
# file_locked 並給明確提示。
function Test-FileLockError {
  param([string]$LogPath)
  if (-not (Test-Path $LogPath)) { return $false }
  $patterns = 'EBUSY|EACCES|EPERM|Permission denied|in use by another|another process|file is locked|resource busy|access is denied'
  return $null -ne (Select-String -Path $LogPath -Pattern $patterns -CaseSensitive:$false -Quiet)
}

# --- v1.17.66 Self-check 觀測管道保證執行（IR-038） ---
# 用 try { 主流程 } catch { 印錯記 exit code } finally { 跑 self-check }
# 確保升級任何階段失敗，server 都能收到當下狀態 + 7 項本機 check + env。
$script:selfCheckRan = $false
$script:exitCode = 0
function Run-SelfCheckOnce {
  if ($script:selfCheckRan) { return }
  $script:selfCheckRan = $true
  $selfCheckScript = Join-Path $OwnMindDir 'scripts\install-helpers\self-check.cjs'
  if (Test-Path $selfCheckScript) {
    try { & node $selfCheckScript --trigger=post_upgrade } catch { }
  }
}

try {

# --- 0. Pre-check ---
Step "check" "Checking OwnMind directory"
if (-not (Test-Path $OwnMindDir)) { Fail "no_ownmind" "$OwnMindDir not found; run install.ps1 for fresh install" }
if (-not (Test-Path (Join-Path $OwnMindDir ".git"))) { Fail "no_git" "$OwnMindDir is not a git repo" }

# --- 1. Backup ---
Step "backup" "Backing up to $BackupDir"
try { Copy-Item -Recurse -Path $OwnMindDir -Destination $BackupDir; OK "backup" "Backup complete" }
catch { Fail "backup_failed" "Backup failed: $_" }

function Rollback {
  Step "rollback" "Restoring backup $BackupDir -> $OwnMindDir"
  try {
    Remove-Item -Recurse -Force $OwnMindDir -ErrorAction Stop
    Move-Item -Path $BackupDir -Destination $OwnMindDir
    OK "rollback" "Restored previous version"
  } catch { Write-Host "ERROR:rollback_failed:$_" }
}

# --- 2. git pull ---
# v1.17.79：先偵測 dirty working tree（user 的 AI 助手手動編輯 OwnMind 內檔很常見），
# dirty 就 Report-Error + git fetch + reset --hard origin/main 強制對齊（backup 保險絲已先做）。
# 真實案例：vin-windows-test 的 AI 編輯 mcp/start.cmd 加 fallback，下次 git pull --ff-only
# 直接被 reject、整個升級卡住，server 完全沒紀錄。
Step "pull" "Pulling latest OwnMind"
Push-Location $OwnMindDir

$dirty = git status --porcelain 2>$null
if ($dirty) {
  Step "pull_dirty" "Working tree has uncommitted changes; auto-aligning to origin/main (backup already saved)"
  $dirtyLog = "$LogFile.dirty"
  $dirty | Out-File -FilePath $dirtyLog -Encoding utf8
  Report-Error -Kind "upgrade_dirty_tree" -Detail "git status --porcelain non-empty; auto reset --hard to origin/main" -ContextFile $dirtyLog
  git fetch origin 2>&1 | Out-File -Append $LogFile -Encoding utf8
  if ($LASTEXITCODE -eq 0) {
    git reset --hard origin/main 2>&1 | Out-File -Append $LogFile -Encoding utf8
  }
  if ($LASTEXITCODE -ne 0) {
    Report-Error -Kind "upgrade_git_pull_failed" -Detail "fetch + reset --hard origin/main failed" -ContextFile $LogFile
    Pop-Location
    Rollback
    Fail "git_pull" "Force-align failed (network or permissions); backup restored"
  }
  OK "pull" "Force-aligned (dirty changes overwritten; previous state in backup)"
} else {
  $pullOut = git pull --ff-only 2>&1
  if ($LASTEXITCODE -ne 0) {
    Report-Error -Kind "upgrade_git_pull_failed" -Detail "git pull --ff-only failed (network or non-ff merge)" -ContextFile $LogFile
    Pop-Location
    Rollback
    Fail "git_pull" "git pull failed; backup restored"
  }
  OK "pull" "git pull complete"
}

# --- 3. npm install (MCP) ---
$mcpDir = Join-Path $OwnMindDir "mcp"
if (Test-Path (Join-Path $mcpDir "package.json")) {
  Step "npm_install" "Updating MCP dependencies"
  Set-Location $mcpDir
  npm install --silent 2>&1 | Out-File -Append $LogFile -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    if (Test-FileLockError $LogFile) {
      Report-Error -Kind "upgrade_file_locked" -Detail "npm install hit file lock (likely Claude Code running)" -ContextFile $LogFile
      Pop-Location
      Rollback
      Fail "file_locked" "Files in use by another process (likely Claude Code). Close Claude Code completely, then re-run upgrade."
    }
    Report-Error -Kind "upgrade_npm_install_failed" -Detail "MCP npm install failed" -ContextFile $LogFile
    Pop-Location
    Rollback
    Fail "npm_install" "MCP npm install failed; backup restored"
  }
  OK "npm_install" "MCP dependencies updated"
  Set-Location $OwnMindDir
}

# --- 4. Re-run install.ps1（從現有 ~/.claude/settings.json 讀 creds）---
#
# BUG FIX (v1.17.6): previously called `install.ps1 --update`, but install.ps1
# doesn't support `--update` — it parses $args[0] as API_KEY, so `--update`
# got treated as the key, leading to silent mis-configuration. Now mirrors
# the bash interactive-upgrade.sh pattern: read creds from settings.json
# and pass them as positional args.
Step "install" "Re-running install.ps1 (sync skills / hooks / scheduler)"
$installScript = Join-Path $OwnMindDir "install.ps1"
$claudeSettings = Join-Path $env:USERPROFILE ".claude\settings.json"
$apiKey = ""
$apiUrl = ""
if (Test-Path $claudeSettings) {
  try {
    $settings = Get-Content $claudeSettings -Raw | ConvertFrom-Json
    if ($settings.mcpServers -and $settings.mcpServers.ownmind -and $settings.mcpServers.ownmind.env) {
      $apiKey = $settings.mcpServers.ownmind.env.OWNMIND_API_KEY
      $apiUrl = $settings.mcpServers.ownmind.env.OWNMIND_API_URL
    }
  } catch { }
}

if (-not (Test-Path $installScript)) {
  Step "install" "install.ps1 not found; skipping (structure abnormal, reinstall recommended)"
} elseif ([string]::IsNullOrEmpty($apiKey) -or [string]::IsNullOrEmpty($apiUrl)) {
  Step "install" "No existing credentials; skipping install.ps1 re-run (skill/hook synced by update.sh)"
} else {
  & powershell -ExecutionPolicy Bypass -File $installScript $apiKey $apiUrl 2>&1 | Out-File -Append $LogFile -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    Pop-Location
    Rollback
    Fail "install" "install.ps1 failed (see $LogFile); backup restored"
  }
  OK "install" "Setup complete"
}

# --- 5. Re-register Task Scheduler ---
$taskScript = Join-Path $OwnMindDir "scripts\windows\register-scanner-task.ps1"
if (Test-Path $taskScript) {
  Step "reschedule" "Re-registering Task Scheduler"
  & powershell -ExecutionPolicy Bypass -File $taskScript 2>&1 | Out-File -Append $LogFile -Encoding utf8
  if ($LASTEXITCODE -eq 0) { OK "reschedule" "Task Scheduler re-registered" }
  else { Step "reschedule" "Task Scheduler re-register failed; upgrade itself complete" }
}

# --- 6. 驗測 + 清理 ---
# v1.17.66：bash 走 Find-GitBash helper 避開 WSL relay；
#           verify 失敗不再 Rollback（觀測 ≠ 升級成功與否的判定條件）
$verifyScript = Join-Path $OwnMindDir "scripts\verify-upgrade.sh"
if (Test-Path $verifyScript) {
  $findGitBashHelper = Join-Path $OwnMindDir 'scripts\windows\lib\find-git-bash.ps1'
  $bashExe = $null
  if (Test-Path $findGitBashHelper) {
    . $findGitBashHelper
    $bashExe = Find-GitBash
  }

  if (-not $bashExe) {
    Step "verify_local" "Git Bash not found (install from https://git-scm.com/); skipping verify but upgrade continues"
  } else {
    Step "verify_local" "Verifying local components"
    & $bashExe $verifyScript --local 2>&1 | Out-File -Append $LogFile -Encoding utf8
    if ($LASTEXITCODE -eq 0) { OK "verify_local" "Local components present" }
    else { Step "verify_local" "Local verification failed (upgrade continues; self-check will observe)" }

    Step "verify_server" "Verifying server"
    & $bashExe $verifyScript --server 2>&1 | Out-File -Append $LogFile -Encoding utf8
    if ($LASTEXITCODE -eq 0) { OK "verify_server" "Server reachable" }
    else { Step "verify_server" "Server verification failed (possible network blip)" }

    Step "cleanup" "Cleaning up test data"
    & $bashExe $verifyScript --cleanup 2>&1 | Out-File -Append $LogFile -Encoding utf8 | Out-Null
    OK "cleanup" "Test data cleaned"
  }
}

Pop-Location

$pkg = Get-Content (Join-Path $OwnMindDir "package.json") -Raw | ConvertFrom-Json
$Version = $pkg.version

# --- 7. Dismiss 已過時的升級廣播（v1.17.18） ---
# 把 dismiss 從 AI skill 移到腳本（IR-027 邏輯卡控），對齊 .sh 行為。
if ($apiKey -and $apiUrl -and $Version) {
  Step "dismiss" "Dismissing stale upgrade broadcasts"
  try {
    $headers = @{
      "Authorization"     = "Bearer $apiKey"
      "X-Ownmind-Version" = "$Version"
    }
    $activeUrl = "$apiUrl/api/broadcast/active?tool=claude-code&client_version=$Version"
    $active = Invoke-RestMethod -Uri $activeUrl -Headers $headers -Method Get -TimeoutSec 5 -ErrorAction Stop
    $count = 0
    if ($active) {
      foreach ($b in @($active)) {
        if ($b.type -eq "upgrade_reminder" -and $b.id) {
          $body = @{ broadcast_id = [int]$b.id; tool = "claude-code" } | ConvertTo-Json -Compress
          try {
            Invoke-RestMethod -Uri "$apiUrl/api/broadcast/dismiss" -Headers $headers `
              -Method Post -ContentType "application/json" -Body $body -TimeoutSec 3 | Out-Null
            $count++
          } catch { }
        }
      }
    }
    OK "dismiss" "Upgrade broadcasts dismissed ($count)"
  } catch {
    Step "dismiss" "Dismiss failed (network or server blip); does not affect upgrade outcome"
  }
}

# v1.17.70：升級成功末段 sweep ~/.ownmind.bak.<ts>/ 超過 N 天的（IR-027 邏輯卡控）。
# 預設 7 天，可用 OWNMIND_BACKUP_RETENTION_DAYS 環境變數覆蓋。
# 防呆：sweep 失敗（權限 / 鎖定）不影響升級訊息，但用 STEP 記下 error message
# 給未來 debug 用（IR-038 觀測管道）。
$RetentionDays = if ($env:OWNMIND_BACKUP_RETENTION_DAYS) {
  [int]$env:OWNMIND_BACKUP_RETENTION_DAYS
} else { 7 }
Step "sweep" "Sweeping backups older than $RetentionDays days (if any)"
try {
  $cutoff = (Get-Date).AddDays(-$RetentionDays)
  Get-ChildItem -LiteralPath $HOME -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '.ownmind.bak.*' -and $_.LastWriteTime -lt $cutoff } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  OK "sweep" "Old backup sweep complete"
} catch {
  Step "sweep" "Sweep skipped (error: $($_.Exception.Message))"
}

OK "done" "Upgrade complete -> version $Version. Backup kept at $BackupDir (auto-swept after $RetentionDays days)"

}
catch {
  # v1.17.66 review fix — Fail() throw 的訊息（已含 ERROR:<code>:<msg> 前綴）
  # 在這裡統一印 stdout，再讓 finally 跑 self-check
  $errMsg = $null
  if ($_.Exception -and $_.Exception.Message) { $errMsg = $_.Exception.Message }
  if (-not $errMsg) { $errMsg = "$_" }
  Write-Host $errMsg
  $script:exitCode = 1
}
finally {
  # v1.17.66 — 不論升級成功失敗，self-check.cjs 一定要跑（IR-038 觀測管道）
  Run-SelfCheckOnce
}

exit $script:exitCode
