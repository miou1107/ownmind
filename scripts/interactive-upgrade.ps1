# OwnMind 互動式升級 script — Windows PowerShell (v1.17.0 P5)
#
# 用法：powershell -ExecutionPolicy Bypass -File ~/.ownmind/scripts/interactive-upgrade.ps1
# stdout 格式與 bash 版相同（INFO / OK / ERROR / ASK 前綴）

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
function Fail($code, $msg) { Write-Host "ERROR:${code}:$msg"; exit 1 }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

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
  npm install --silent 2>&1 | Out-File -Append $LogFile
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
  & powershell -ExecutionPolicy Bypass -File $installScript $apiKey $apiUrl 2>&1 | Out-File -Append $LogFile
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
  & powershell -ExecutionPolicy Bypass -File $taskScript 2>&1 | Out-File -Append $LogFile
  if ($LASTEXITCODE -eq 0) { OK "reschedule" "Task Scheduler 重註冊完成" }
  else { Step "reschedule" "Task Scheduler 重註冊失敗，但升級本體已完成" }
}

# --- 6. 驗測 + 清理 ---
$verifyScript = Join-Path $OwnMindDir "scripts\verify-upgrade.sh"
if (Test-Path $verifyScript) {
  Step "verify_local" "本地元件驗測"
  bash $verifyScript --local 2>&1 | Out-File -Append $LogFile
  if ($LASTEXITCODE -eq 0) { OK "verify_local" "本地元件全在" }
  else { Rollback; Fail "verify_local" "本地驗測失敗" }

  Step "verify_server" "Server 驗測"
  bash $verifyScript --server 2>&1 | Out-File -Append $LogFile
  if ($LASTEXITCODE -eq 0) { OK "verify_server" "server 正常" }
  else { Step "verify_server" "server 驗測失敗（可能網路暫斷）" }

  Step "cleanup" "清理測試資料"
  bash $verifyScript --cleanup 2>&1 | Out-File -Append $LogFile | Out-Null
  OK "cleanup" "測試資料已清"
}

Pop-Location

$pkg = Get-Content (Join-Path $OwnMindDir "package.json") -Raw | ConvertFrom-Json
OK "done" "升級完成 → 版本：$($pkg.version)。備份保留於 $BackupDir"

exit 0
