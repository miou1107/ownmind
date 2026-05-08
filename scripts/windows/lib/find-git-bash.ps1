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

function Test-IsGitBash {
  param([Parameter(Mandatory)][string]$BashPath)

  if (-not (Test-Path $BashPath -PathType Leaf)) { return $false }

  # 跳過 System32 WSL relay（不論裝沒裝 distro，這條都不是我們要的 Git Bash）
  if ($BashPath -ieq 'C:\Windows\System32\bash.exe') { return $false }

  try {
    # Git Bash --version 印類似：
    #   GNU bash, version 5.1.16(1)-release (x86_64-pc-msys)
    # WSL distro 印類似：
    #   GNU bash, version 5.0.17(1)-release (x86_64-pc-linux-gnu)
    # WSL relay（沒 distro）會 fail，$LASTEXITCODE != 0
    $out = & $BashPath --version 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { return $false }
    # msys 是 Git Bash 標誌；linux-gnu 是 WSL distro（也不接受，要的是 Git Bash）
    if ($out -match 'msys') { return $true }
    return $false
  } catch {
    return $false
  }
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
  # 1. cache
  if (Test-Path $script:GitBashCacheFile -PathType Leaf) {
    try {
      $cached = (Get-Content $script:GitBashCacheFile -First 1 -ErrorAction Stop).Trim()
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
