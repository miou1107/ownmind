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
Step "check" "檢查 OwnMind 目錄是否存在"
if (-not (Test-Path $OwnMindDir)) { Fail "no_ownmind" "找不到 $OwnMindDir，請先跑 install.ps1 初始安裝" }
if (-not (Test-Path (Join-Path $OwnMindDir ".git"))) { Fail "no_git" "$OwnMindDir 不是 git repo" }

# --- 1. 備份 ---
Step "backup" "備份到 $BackupDir"
try { Copy-Item -Recurse -Path $OwnMindDir -Destination $BackupDir; OK "backup" "備份完成" }
catch { Fail "backup_failed" "備份失敗：$_" }

function Rollback {
  Step "rollback" "還原備份 $BackupDir → $OwnMindDir"
  try {
    Remove-Item -Recurse -Force $OwnMindDir -ErrorAction Stop
    Move-Item -Path $BackupDir -Destination $OwnMindDir
    OK "rollback" "已還原舊版"
  } catch { Write-Host "ERROR:rollback_failed:$_" }
}

# --- 2. git pull ---
Step "pull" "拉取最新 OwnMind"
Push-Location $OwnMindDir
$pullOut = git pull --ff-only 2>&1
if ($LASTEXITCODE -ne 0) {
  Pop-Location
  Rollback
  Fail "git_pull" "git pull 失敗（可能網路或 conflict），備份已還原"
}
OK "pull" "git pull 成功"

# --- 3. npm install (MCP) ---
$mcpDir = Join-Path $OwnMindDir "mcp"
if (Test-Path (Join-Path $mcpDir "package.json")) {
  Step "npm_install" "更新 MCP 依賴"
  Set-Location $mcpDir
  npm install --silent 2>&1 | Out-File -Append $LogFile -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    Pop-Location
    Rollback
    Fail "npm_install" "MCP npm install 失敗，備份已還原"
  }
  OK "npm_install" "MCP 依賴完成"
  Set-Location $OwnMindDir
}

# --- 4. Re-run install.ps1（從現有 ~/.claude/settings.json 讀 creds）---
#
# BUG FIX (v1.17.6): previously called `install.ps1 --update`, but install.ps1
# doesn't support `--update` — it parses $args[0] as API_KEY, so `--update`
# got treated as the key, leading to silent mis-configuration. Now mirrors
# the bash interactive-upgrade.sh pattern: read creds from settings.json
# and pass them as positional args.
Step "install" "重跑 install.ps1（skill / hook / 排程同步）"
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
  Step "install" "找不到 install.ps1，跳過（結構異常，建議重裝）"
} elseif ([string]::IsNullOrEmpty($apiKey) -or [string]::IsNullOrEmpty($apiUrl)) {
  Step "install" "找不到現有 credentials，跳過 install.ps1 重跑（skill/hook 可由後續 update.sh 補）"
} else {
  & powershell -ExecutionPolicy Bypass -File $installScript $apiKey $apiUrl 2>&1 | Out-File -Append $LogFile -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    Pop-Location
    Rollback
    Fail "install" "install.ps1 失敗（詳細見 $LogFile）；備份已還原"
  }
  OK "install" "setup 完成"
}

# --- 5. 重註冊 Task Scheduler ---
$taskScript = Join-Path $OwnMindDir "scripts\windows\register-scanner-task.ps1"
if (Test-Path $taskScript) {
  Step "reschedule" "重註冊 Task Scheduler"
  & powershell -ExecutionPolicy Bypass -File $taskScript 2>&1 | Out-File -Append $LogFile -Encoding utf8
  if ($LASTEXITCODE -eq 0) { OK "reschedule" "Task Scheduler 重註冊完成" }
  else { Step "reschedule" "Task Scheduler 重註冊失敗，但升級本體已完成" }
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
    Step "verify_local" "找不到 Git Bash（請安裝 https://git-scm.com/），跳過 verify 但不擋升級"
  } else {
    Step "verify_local" "本地元件驗測"
    & $bashExe $verifyScript --local 2>&1 | Out-File -Append $LogFile -Encoding utf8
    if ($LASTEXITCODE -eq 0) { OK "verify_local" "本地元件全在" }
    else { Step "verify_local" "本地驗測失敗（不擋升級，繼續走完 self-check 觀測）" }

    Step "verify_server" "Server 驗測"
    & $bashExe $verifyScript --server 2>&1 | Out-File -Append $LogFile -Encoding utf8
    if ($LASTEXITCODE -eq 0) { OK "verify_server" "server 正常" }
    else { Step "verify_server" "server 驗測失敗（可能網路暫斷）" }

    Step "cleanup" "清理測試資料"
    & $bashExe $verifyScript --cleanup 2>&1 | Out-File -Append $LogFile -Encoding utf8 | Out-Null
    OK "cleanup" "測試資料已清"
  }
}

Pop-Location

$pkg = Get-Content (Join-Path $OwnMindDir "package.json") -Raw | ConvertFrom-Json
$Version = $pkg.version

# --- 7. Dismiss 已過時的升級廣播（v1.17.18） ---
# 把 dismiss 從 AI skill 移到腳本（IR-027 邏輯卡控），對齊 .sh 行為。
if ($apiKey -and $apiUrl -and $Version) {
  Step "dismiss" "Dismiss 已過時的升級廣播"
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
    OK "dismiss" "升級廣播已 dismiss（$count 則）"
  } catch {
    Step "dismiss" "Dismiss 失敗（網路或 server 暫斷），不影響升級結果"
  }
}

OK "done" "升級完成 → 版本：$Version。備份保留於 $BackupDir"

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
