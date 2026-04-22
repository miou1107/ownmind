# register-scanner-task.ps1 — OwnMind token usage scanner Windows Task Scheduler 註冊
#
# 用法（install.ps1 會自動呼叫）：
#   powershell -ExecutionPolicy Bypass -File register-scanner-task.ps1
#
# 每 30 分鐘執行一次，使用當前登入 user 身分，即使 IDE 沒開也會跑。

$ErrorActionPreference = 'Stop'

$TaskName = 'OwnMind Usage Scanner'
$OwnMindDir = Join-Path $env:USERPROFILE '.ownmind'
$ScannerJs = Join-Path $OwnMindDir 'hooks\ownmind-usage-scanner.js'
$LogDir = Join-Path $OwnMindDir 'logs'
$NodePathCache = Join-Path $OwnMindDir '.node-path'

# --- 1. 找 node（與 bash wrapper 同策略）---
function Resolve-NodeBinary {
  # 1a. .node-path cache
  if (Test-Path $NodePathCache) {
    $cached = (Get-Content $NodePathCache -First 1).Trim()
    if ($cached -and (Test-Path $cached)) {
      $ver = & $cached --version 2>$null
      if ($LASTEXITCODE -eq 0 -and $ver -match '^v(\d+)') {
        if ([int]$Matches[1] -ge 20) { return $cached }
      }
    }
  }
  # 1b. PATH
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    $ver = & $cmd.Source --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $ver -match '^v(\d+)' -and [int]$Matches[1] -ge 20) {
      return $cmd.Source
    }
  }
  # 1c. 常見位置
  foreach ($p in @(
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe'
  )) {
    if (Test-Path $p) {
      $ver = & $p --version 2>$null
      if ($LASTEXITCODE -eq 0 -and $ver -match '^v(\d+)' -and [int]$Matches[1] -ge 20) {
        return $p
      }
    }
  }
  return $null
}

$NodeBin = Resolve-NodeBinary
if (-not $NodeBin) {
  Write-Error "Node.js v20+ not found. Install Node 20+ and retry."
  exit 1
}

Write-Host "[ownmind] using node: $NodeBin"

# 寫入 cache 給後續 run 用
# 用 [System.IO.File]::WriteAllText 避免 Windows PowerShell 5.1 的 Set-Content -Encoding UTF8 加 BOM
# （BOM 會讓 bash wrapper 的 head 讀出 \ufeff 前綴、執行 [ -x ] 失敗）
New-Item -ItemType Directory -Path $OwnMindDir -Force | Out-Null
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
[System.IO.File]::WriteAllText($NodePathCache, $NodeBin)

# --- 2. 若 task 已存在先移除，避免 duplicate ---
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "[ownmind] removed existing task"
}

# --- 3. 註冊新 task ---
$Action = New-ScheduledTaskAction `
  -Execute $NodeBin `
  -Argument "`"$ScannerJs`""

# 開機後 5 分鐘首次跑，之後每 30 分鐘；無限重複。
# 重要：使用單一 "Once" trigger + Repetition，不要對 AtLogOn trigger 指派
# .Repetition 屬性（某些 Windows build 的 CimInstance 會 reject re-assignment）。
$Trigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(5) `
  -RepetitionInterval (New-TimeSpan -Minutes 30) `
  -RepetitionDuration ([TimeSpan]::MaxValue)

$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description 'OwnMind token usage scanner (every 30 minutes)' | Out-Null

Write-Host "[ownmind] task '$TaskName' registered; first run in 5 min, then every 30 min."
