# OwnMind Universal Bootstrap for Windows PowerShell
#
# Usage:
#   Already installed (upgrade only):
#     powershell -ExecutionPolicy Bypass -File $HOME\.ownmind\scripts\bootstrap.ps1
#     iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex
#   Fresh install / repair (needs API key + URL via args or env):
#     $env:OWNMIND_API_KEY='xxx'; $env:OWNMIND_API_URL='https://your-server.com/ownmind'
#     iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex
#
# Branches:
#   1. ~/.ownmind not present         → fresh clone + install.ps1 (needs API key args/env)
#   2. ~/.ownmind present, no .git    → backup + re-clone + install.ps1 (needs API key args/env)
#   3. ~/.ownmind is a git repo       → delegate to scripts/interactive-upgrade.ps1 (no args needed)
#
# Env overrides (for testing):
#   $env:OWNMIND_DIR   — install path (default: $env:USERPROFILE\.ownmind)
#   $env:OWNMIND_REPO  — git URL      (default: https://github.com/miou1107/ownmind.git)
#
# Log format (machine-readable):
#   "INFO:detect:<message>"   — 進度訊息
#   "OK:done:<message>"       — 步驟成功
#   "ERROR:install:<message>" — 失敗

$ErrorActionPreference = "Stop"

# 環境正規化（v1.17.9, 回報者 Adam）— Git Bash / MSYS 會把 $HOME 污染成 /c/Users/xxx
if ($env:USERPROFILE -and ($HOME -ne $env:USERPROFILE)) {
  Set-Variable -Name HOME -Value $env:USERPROFILE -Force -Scope Global -ErrorAction SilentlyContinue
}

$OwnmindDir = if ($env:OWNMIND_DIR) { $env:OWNMIND_DIR } else { "$env:USERPROFILE\.ownmind" }
$Repo = if ($env:OWNMIND_REPO) { $env:OWNMIND_REPO } else { "https://github.com/miou1107/ownmind.git" }
$Ts = Get-Date -Format "yyyyMMdd-HHmmss"

function Log-Info($code, $msg) { Write-Host "INFO:${code}:${msg}" }
function Log-Ok($code, $msg)   { Write-Host "OK:${code}:${msg}" }
function Log-Err($code, $msg)  { Write-Host "ERROR:${code}:${msg}" -ForegroundColor Red }

Log-Info detect "檢查 OwnMind 安裝狀態（$OwnmindDir）"

# Forward positional args (if any) to install.ps1; install.ps1 falls back to
# $env:OWNMIND_API_KEY / $env:OWNMIND_API_URL when args are empty (see its own
# arg handling). This lets both `bootstrap.ps1 KEY URL` and
# `$env:OWNMIND_API_KEY=... iwr | iex` patterns work.
$InstallArgs = $args

# Branch 1: no install
if (-not (Test-Path "$OwnmindDir")) {
  Log-Info fresh "首次安裝，clone repo"
  git clone "$Repo" "$OwnmindDir"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$OwnmindDir\.git")) {
    Log-Err git_clone "git clone 失敗，請檢查網路或 GitHub 權限"
    exit 1
  }
  Log-Ok clone "clone 完成"
  Set-Location "$OwnmindDir"
  Log-Info install "執行 install.ps1（轉發 API_KEY / API_URL）"
  & powershell -ExecutionPolicy Bypass -File .\install.ps1 @InstallArgs
  if ($LASTEXITCODE -ne 0) { Log-Err install "install.ps1 失敗（缺 API_KEY/URL 或其他錯誤）"; exit 1 }
  Log-Ok done "首次安裝完成"
  exit 0
}

# Branch 2: broken
if (-not (Test-Path "$OwnmindDir\.git")) {
  $Bak = "$OwnmindDir.broken.$Ts"
  Log-Info broken "$OwnmindDir 存在但不是 git repo，備份至 $Bak"
  Move-Item "$OwnmindDir" "$Bak"
  Log-Ok backup "已備份"
  Log-Info fresh "重新 clone"
  git clone "$Repo" "$OwnmindDir"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$OwnmindDir\.git")) {
    Log-Err git_clone "重新 clone 失敗，舊資料已保留於 $Bak"
    exit 1
  }
  Set-Location "$OwnmindDir"
  & powershell -ExecutionPolicy Bypass -File .\install.ps1 @InstallArgs
  if ($LASTEXITCODE -ne 0) { Log-Err install "install.ps1 失敗（缺 API_KEY/URL 或其他錯誤）"; exit 1 }
  Log-Ok done "修復完成（舊資料保留於 $Bak，3 天後可手動刪除）"
  exit 0
}

# Branch 3: normal upgrade
Log-Info upgrade "已安裝，交給 interactive-upgrade.ps1"
& powershell -ExecutionPolicy Bypass -File "$OwnmindDir\scripts\interactive-upgrade.ps1"
exit $LASTEXITCODE
