# scripts/windows/lib/find-git-bash.ps1
#
# Find-GitBash — 找出可用的 Git Bash 執行檔，避開 WSL relay。
#
# 為什麼要這個 helper：
#   Windows 10/11 內建 C:\Windows\System32\bash.exe（WSL relay）— 沒裝 distro 也存在；
#   PowerShell PATH 解析優先 System32，所以 PowerShell 直接 `bash xxx` 必定中 WSL relay。
#   執行結果是 `<3>WSL ERROR: CreateProcessEntryCommon execvpe /bin/bash failed`，
#   讓 interactive-upgrade.ps1 的 verify_local 階段假性失敗（v1.17.66 修法的根因）。
#
# 用法：
#   . (Join-Path $OwnMindDir 'scripts\windows\lib\find-git-bash.ps1')
#   $bash = Find-GitBash
#   if (-not $bash) { Write-Warning '找不到 Git Bash' ; return }
#   & $bash $script $args
#
# 偵測順序：
#   1. ~/.ownmind/.git-bash-path cache（成功偵測過寫入）
#   2. 常見安裝路徑：
#      - $env:ProgramFiles\Git\bin\bash.exe
#      - ${env:ProgramFiles(x86)}\Git\bin\bash.exe
#      - $env:LOCALAPPDATA\Programs\Git\bin\bash.exe
#   3. where.exe bash 過濾掉 C:\Windows\System32\bash.exe
#   4. 都找不到 → 回 $null

$script:GitBashCacheFile = Join-Path $env:USERPROFILE '.ownmind\.git-bash-path'

# v1.26.99 — every candidate this run rejected, and why. Find-GitBash returning $null used
# to be indistinguishable from "no bash on this machine", so the caller told the user to go
# install Git Bash while Git Bash sat in Program Files. Callers render this with
# Get-GitBashSearchReport so the message describes what actually happened.
$script:GitBashRejected = @()

function Test-IsGitBash {
  param([Parameter(Mandatory)][string]$BashPath)

  if (-not (Test-Path $BashPath -PathType Leaf)) { return $false }

  # 跳過 System32 WSL relay（不論裝沒裝 distro，這條都不是我們要的 Git Bash）
  if ($BashPath -ieq 'C:\Windows\System32\bash.exe') { return $false }

  try {
    # Git Bash --version 印類似：
    #   2.54 及更早：GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)
    #   2.55 之後：  GNU bash, version 5.3.15(1)-release (x86_64-pc-cygwin)
    # WSL distro 印類似：
    #   GNU bash, version 5.0.17(1)-release (x86_64-pc-linux-gnu)
    # WSL relay（沒 distro）會 fail，$LASTEXITCODE != 0
    $out = & $BashPath --version 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      $script:GitBashRejected += "$BashPath (--version exited $LASTEXITCODE)"
      return $false
    }
    # linux-gnu 先擋掉：那是 WSL distro，不是 Git Bash。
    if ($out -match 'linux-gnu') {
      $script:GitBashRejected += "$BashPath (WSL distro, not Git Bash)"
      return $false
    }
    # v1.26.99 — cygwin 加進來。Git for Windows 2.55 把 bash 的 build triplet 從 msys
    # 換成 cygwin，而這裡只比對 msys，於是每一台更新到 2.55 的機器都會把好好的
    # Git Bash 判成不合格，Find-GitBash 回 $null。呼叫端的反應是跳過 verify_local /
    # verify_server 然後繼續，所以整件事唯一的痕跡，是一句叫使用者去 git-scm.com
    # 裝 Git Bash 的訊息 —— 而 Git Bash 就在 Program Files 裡。
    # 2026-08-08 於 TANK 更新到 2.55.0.windows.3 之後實測到。
    if ($out -match 'msys|cygwin') { return $true }
    $first = @($out -split "`n" | Where-Object { $_.Trim() }) | Select-Object -First 1
    $script:GitBashRejected += "$BashPath (unrecognized build: $(if ($first) { $first.Trim() } else { 'no --version output' }))"
    return $false
  } catch {
    $script:GitBashRejected += "$BashPath ($($_.Exception.Message))"
    return $false
  }
}

# 給呼叫端用的一句話，說明這次搜尋到底發生什麼事。
function Get-GitBashSearchReport {
  if (-not $script:GitBashRejected -or @($script:GitBashRejected).Count -eq 0) {
    return "no bash.exe found under Program Files, LOCALAPPDATA or PATH"
  }
  return "found but rejected -> " + (@($script:GitBashRejected) -join "; ")
}

function Save-GitBashCache {
  param([Parameter(Mandatory)][string]$Path)
  try {
    $dir = Split-Path $script:GitBashCacheFile -Parent
    if (-not (Test-Path $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    # 用 [System.IO.File]::WriteAllText 避免 Set-Content 加 BOM
    # （register-scanner-task.ps1 同模式，BOM 會讓後續讀檔的腳本踩雷）
    [System.IO.File]::WriteAllText($script:GitBashCacheFile, $Path)
  } catch {}
}

function Find-GitBash {
  # 每次搜尋重新累積，否則同一個 session 呼叫兩次會把上一輪的拒絕理由一起報出來。
  $script:GitBashRejected = @()

  # 1. cache
  if (Test-Path $script:GitBashCacheFile -PathType Leaf) {
    try {
      # -Encoding UTF8 for the same reason as register-scanner-task.ps1: this cache is written
      # BOM-less, and a path under a Chinese username decodes wrong on a cp950 machine.
      $cached = (Get-Content $script:GitBashCacheFile -First 1 -Encoding UTF8 -ErrorAction Stop).Trim()
      if ($cached -and (Test-IsGitBash -BashPath $cached)) {
        return $cached
      }
    } catch {}
  }

  # 2. 常見安裝路徑
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')
  )
  foreach ($p in $candidates) {
    if (-not $p) { continue }
    if (Test-IsGitBash -BashPath $p) {
      Save-GitBashCache -Path $p
      return $p
    }
  }

  # 3. where.exe（過濾 WSL relay）
  try {
    $whereOut = & where.exe bash 2>$null
    if ($LASTEXITCODE -eq 0 -and $whereOut) {
      foreach ($line in @($whereOut)) {
        $line = $line.Trim()
        if (-not $line) { continue }
        if (Test-IsGitBash -BashPath $line) {
          Save-GitBashCache -Path $line
          return $line
        }
      }
    }
  } catch {}

  return $null
}
