# register-scanner-task.ps1 — OwnMind token usage scanner Windows Task Scheduler 註冊
#
# 用法（install.ps1 會自動呼叫）：
#   powershell -ExecutionPolicy Bypass -File register-scanner-task.ps1
#
# 每 120 分鐘執行一次，使用當前登入 user 身分，即使 IDE 沒開也會跑。

$ErrorActionPreference = 'Stop'

# 環境正規化（v1.17.9, 回報者 Bob）— Git Bash / MSYS 會把 $HOME 污染成 /c/Users/xxx
if ($env:USERPROFILE -and ($HOME -ne $env:USERPROFILE)) {
  Set-Variable -Name HOME -Value $env:USERPROFILE -Force -Scope Global -ErrorAction SilentlyContinue
}

$TaskName = 'OwnMind Usage Scanner'
$OwnMindDir = Join-Path $env:USERPROFILE '.ownmind'
$ScannerJs = Join-Path $OwnMindDir 'hooks\ownmind-usage-scanner.js'
$LogDir = Join-Path $OwnMindDir 'logs'
$NodePathCache = Join-Path $OwnMindDir '.node-path'

# --- 1. 找 node（與 bash wrapper 同策略）---
function Resolve-NodeBinary {
  # 1a. .node-path cache
  if (Test-Path $NodePathCache) {
    # -Encoding UTF8: this cache is written BOM-less through WriteAllText further down, and a
    # node path under a Chinese Windows username is not ASCII. Read back on cp950 without it,
    # the path comes out mangled, Test-Path says no, and the cache silently never hits.
    $cached = (Get-Content $NodePathCache -First 1 -Encoding UTF8).Trim()
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

# --- 2. 註冊 task ---
#
# v1.26.65 — 這裡以前是「先 Unregister 舊的、再 Register 新的」。因為腳本開頭設了
# $ErrorActionPreference = 'Stop'，中間任何一步出錯，使用者就會停在「舊的已經刪掉、
# 新的還沒建立」的狀態，而且永遠不會自己恢復。
#
# 這不是假設。下面 v1.17.66 那段註解記著：兩個不存在的參數讓 Register 直接 throw，
# 「task 完全沒註冊」，Bob 跟 Alice 兩台升級踩到。當時修掉參數，沒有修掉「把小錯誤
# 放大成永久損壞」的結構。
#
# 2026-08-05 正式機追查：Adam 的掃描器從 07-15 之後一次都沒跑過，二十天沒有人發現。
# Register-ScheduledTask -Force 直接覆蓋同名 task，一步完成，中間沒有空窗。
# v1.17.66 — 改用 wscript.exe + run-hidden.vbs 包 node.exe，避免每次跑都跳 console window
# （Alice 回報：每 30 分鐘閃 PowerShell/console 視窗 + 補跑造成連跳，影響工作體驗）
$VbsLauncher = Join-Path $OwnMindDir 'scripts\windows\run-hidden.vbs'
$Action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "`"$VbsLauncher`" `"$NodeBin`" `"$ScannerJs`""

# 開機後 5 分鐘首次跑，之後每 120 分鐘；無限重複。
# 重要：使用單一 "Once" trigger + Repetition，不要對 AtLogOn trigger 指派
# .Repetition 屬性（某些 Windows build 的 CimInstance 會 reject re-assignment）。
# v1.17.11 — Alice 回報 36500 天仍超出 Task Scheduler COM validator 範圍
# （validator 上限約 9999 天，超過會吐 warning "超出允許範圍" 再 fallback）。
# 改用 9999 天（~27 年，PowerShell 社群公認的 safe-forever 值），保證 Win10/11
# 所有 build 都接受不吐 warning。task 在 ~27 年內手動重裝過很多次，實務上等於永久。
# v1.17.66 — 30 分鐘 → 120 分鐘：scanner 撈的是過去 log，2hr 延遲完全可接受；
#            降頻 4× 後背景負載大幅下降（Alice/Bob 筆電友善）。
$Trigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(5) `
  -RepetitionInterval (New-TimeSpan -Minutes 120) `
  -RepetitionDuration (New-TimeSpan -Days 9999)

# v1.17.67 修 v1.17.66 雷：原本想加 -DontStartIfOnBatteries +
# -StopIfGoingOnBatteries 做電池友善，但這兩個都不是
# New-ScheduledTaskSettingsSet 的合法參數（正確名是 -DisallowStartIfOnBatteries
# 和反向 switch -DontStopIfGoingOnBatteries），在 PS 5.1 + PS 7 都會直接 throw、
# task 完全沒註冊（Bob / Alice 兩台 v1.17.66 升級踩到）。
#
# 解法：直接刪掉 — Windows Task Scheduler 預設行為本來就是
#   1. 電池上不啟動（要顯式 -AllowStartIfOnBatteries 才會反向）
#   2. 切電池就停（要顯式 -DontStopIfGoingOnBatteries 才會反向）
# 預設已經是「爛電池友善」，不用加任何 param。
# StartWhenAvailable 維持，接電源回來會自動補跑。
#
# 防再現：tests/ps1-windows-compat.test.js 加了 param 白名單驗證，
# 之後再有人在這支腳本打錯 cmdlet param 立刻紅燈。
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
  -Force `
  -Description 'OwnMind token usage scanner (every 120 minutes)' | Out-Null

# --- 4. 確認真的建起來了 ---
# Register-ScheduledTask 沒有 throw 是不錯的證據，但不是證明，而這個 repo 已經出過
# 一次「以為註冊好了、實際上機器上什麼都沒有」。多問一次的成本是一個 call。
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
  Write-Error "[ownmind] task '$TaskName' is not present after registration; the usage scanner will not run."
  exit 1
}

Write-Host "[ownmind] task '$TaskName' registered; first run in 5 min, then every 120 min."
