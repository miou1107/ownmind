# OwnMind 一鍵安裝腳本（Windows PowerShell 原生版）
# 用法: .\install.ps1 YOUR_API_KEY YOUR_API_URL
# 或: $env:OWNMIND_API_KEY='xxx'; $env:OWNMIND_API_URL='https://your-server.com/ownmind'; irm https://raw.githubusercontent.com/miou1107/ownmind/main/install.ps1 | iex

# --- ExecutionPolicy Bypass for current process (v1.17.76, 回報者 vin-windows-test) ---
# 預設 PS Restricted 會擋 npm install / npx 的 cmdlet — 只影響當前 process，不動 system policy。
try {
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue
} catch { }

# --- 環境正規化（v1.17.9, 回報者 Adam）---
# 從 Git Bash / MSYS / Cygwin 呼叫 powershell 時，$HOME 會是 POSIX 格式 /c/Users/xxx，
# 跟 Windows path 串接變 C:\c\Users\xxx 怪路徑。強制把 $HOME 指向 $env:USERPROFILE。
if ($env:USERPROFILE -and ($HOME -ne $env:USERPROFILE)) {
  Set-Variable -Name HOME -Value $env:USERPROFILE -Force -Scope Global -ErrorAction SilentlyContinue
}

# --- Reload-Path helper (v1.17.76) ---
# winget install 完不會更新當前 session 的 $env:Path。從 Machine + User scope
# 重組 PATH 讓剛裝的 node/git 馬上能用，不必 user 重開 terminal。
function Reload-Path {
  $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
  if ($machinePath -and $userPath) {
    $env:Path = "$machinePath;$userPath"
  } elseif ($machinePath) {
    $env:Path = $machinePath
  }
}

# --- 參數處理（同時支援 param 和環境變數，irm | iex 不支援 param）---
# 過濾 flag-like args（如舊版 interactive-upgrade.ps1 傳的 --update），避免被當 API key
$PosArgs = @($args | Where-Object { $_ -notlike '-*' })
if ($PosArgs.Count -ge 1) { $ApiKey = $PosArgs[0] } else { $ApiKey = $env:OWNMIND_API_KEY }
if ($PosArgs.Count -ge 2) { $ApiUrl = $PosArgs[1] } else { $ApiUrl = $env:OWNMIND_API_URL }

if (-not $ApiKey) {
  Write-Error "API Key required`nUsage:   .\install.ps1 YOUR_API_KEY YOUR_API_URL`nOr env:  `$env:OWNMIND_API_KEY='xxx'; `$env:OWNMIND_API_URL='https://...'"
  exit 1
}
if (-not $ApiUrl) {
  Write-Error "API URL required`nUsage: .\install.ps1 YOUR_API_KEY YOUR_API_URL"
  exit 1
}

Write-Host "OwnMind installer" -ForegroundColor Cyan

# --- v1.17.78 IR-038：install_started beacon（觀測管道補洞）---
# 為什麼必要：install.ps1 中段任何 fatal error（npm install 被 ExecutionPolicy 擋、
# winget 失敗等）都會 exit 1，end-of-file 的 self-check 永遠跑不到，admin 看不到
# 「user 試圖安裝過」。在 API key 確認後立刻送一個輕量 beacon，至少留一筆紀錄。
# fire-and-forget — 失敗不擋安裝（network 沒通也照樣裝得起來）。
function Send-InstallBeacon {
  param([string]$Trigger)
  if (-not $ApiUrl -or -not $ApiKey) { return }
  $machine = try { [System.Net.Dns]::GetHostName() } catch { 'unknown' }
  $body = @{
    ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    trigger = $Trigger
    client_version = 'install-script'
    platform = 'win32'
    node_version = $null
    machine = $machine
  } | ConvertTo-Json -Compress
  try {
    Invoke-RestMethod -Uri "$($ApiUrl.TrimEnd('/'))/api/debug/install-check" `
      -Method POST `
      -Headers @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' } `
      -Body $body `
      -TimeoutSec 5 -ErrorAction Stop | Out-Null
    return
  } catch {
    # v1.17.80（vin-windows-test 第四輪）：POST 失敗 → spool 到 .upload-spool.jsonl
    # 下次 self-check 開頭 retrySpool() 自動補傳。BOM-less UTF-8 防 Node JSON.parse 炸。
    try {
      $spoolDir = Join-Path $HOME '.ownmind\logs'
      if (-not (Test-Path $spoolDir)) {
        New-Item -ItemType Directory -Force -Path $spoolDir -ErrorAction SilentlyContinue | Out-Null
      }
      $spoolFile = Join-Path $spoolDir '.upload-spool.jsonl'
      $utf8NoBom = New-Object System.Text.UTF8Encoding $false
      [System.IO.File]::AppendAllText($spoolFile, ($body + "`n"), $utf8NoBom)
    } catch { }
  }
}
Send-InstallBeacon -Trigger 'install_started'

# v1.17.79 — 載入 report-error helper（IR-038 觀測管道）
# 注意：第一次安裝時 ~/.ownmind 還沒 clone 下來，helper 還不存在 — clone 完才能用。
# 設一個本地 fallback 先擋著。
function Report-Error { param($Kind, $Detail, $ContextFile = "") }
function Maybe-LoadReportError {
  $h = Join-Path $HOME '.ownmind\scripts\install-helpers\report-error.ps1'
  if (Test-Path $h) { . $h }
}

# --- 檢查必要工具（v1.17.76：缺 git/node 走 winget 自動裝，回報者 vin-windows-test）---
# v1.17.75 之前：缺 git 或 node 直接 Write-Error exit，user 沒裝過 = 完全卡死。
# 現在：跟 sqlite3 同 pattern → winget 自動裝、reload PATH、再驗證一次。
function Install-WithWinget {
  param(
    [string]$ToolName,    # "git" / "node"
    [string]$WingetId,    # "Git.Git" / "OpenJS.NodeJS.LTS"
    [string]$ManualUrl    # 手動安裝 fallback URL
  )
  Write-Host "[WARN] $ToolName not found (required by OwnMind)" -ForegroundColor Yellow
  $hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
  if (-not $hasWinget) {
    Write-Error "$ToolName missing and winget unavailable. Install from $ManualUrl then retry."
    exit 1
  }
  Write-Host "[INFO] Auto-installing $WingetId via winget (1-2 min)"
  try {
    winget install --id $WingetId --scope user --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Error "winget install $WingetId failed (exit=$LASTEXITCODE). Install $ToolName manually ($ManualUrl) and retry."
      exit 1
    }
  } catch {
    Write-Error "winget install $WingetId failed: $_. Install $ToolName manually ($ManualUrl) and retry."
    exit 1
  }
  Reload-Path
  if (-not (Get-Command $ToolName -ErrorAction SilentlyContinue)) {
    Write-Error "$ToolName installed but not visible in current PowerShell session. Close this terminal completely, reopen, and re-run the same install command."
    exit 1
  }
  Write-Host "[ OK ] $ToolName installed (PATH reloaded)" -ForegroundColor Green
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  try {
    Install-WithWinget -ToolName "git" -WingetId "Git.Git" -ManualUrl "https://git-scm.com/download/win"
  } catch {
    Report-Error -Kind "install_winget_git_failed" -Detail "winget Git.Git failed: $_"
    throw
  }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  try {
    Install-WithWinget -ToolName "node" -WingetId "OpenJS.NodeJS.LTS" -ManualUrl "https://nodejs.org/"
  } catch {
    Report-Error -Kind "install_winget_node_failed" -Detail "winget OpenJS.NodeJS.LTS failed: $_"
    throw
  }
}

# Node 版本驗證（>= v20，scanner / mcp 需要）
$nodeVerRaw = (& node --version 2>$null)
$nodeVer = $nodeVerRaw -replace '^v', ''
$nodeMajor = 0
try { $nodeMajor = [int]($nodeVer -split '\.' | Select-Object -First 1) } catch { }
if ($nodeMajor -lt 20) {
  Write-Error "Node.js too old ($nodeVerRaw); OwnMind requires v20+. Upgrade with: winget upgrade OpenJS.NodeJS.LTS"
  exit 1
}
Write-Host "   Node.js: $nodeVerRaw ✓" -ForegroundColor Gray

# --- v1.17.77: 把 node 安裝目錄持久化寫入 User PATH（回報者 vin-windows-test 第二輪）---
# 為什麼必要：winget 只更新 Machine PATH，但 already-running 的 Claude Code 不會 reload；
# 它 spawn `cmd.exe /c start.cmd` 時繼承的 PATH 仍 stale → MCP server 起不來。
# 寫 User PATH 確保「下次開新 terminal / 重啟 Claude Code」就會找到，跟 fallback 兩層守住。
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $nodeDir = (Split-Path -Parent $nodeCmd.Path).TrimEnd('\')
  $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $allParts = @()
  if ($userPath) { $allParts += $userPath -split ';' }
  if ($machinePath) { $allParts += $machinePath -split ';' }
  $alreadyInPath = $false
  foreach ($p in $allParts) {
    if ($p -and ($p.TrimEnd('\') -ieq $nodeDir)) { $alreadyInPath = $true; break }
  }
  if (-not $alreadyInPath) {
    $newUserPath = if ($userPath) { "$userPath;$nodeDir" } else { $nodeDir }
    try {
      [System.Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
      Write-Host "[ OK ] Node path persisted to User PATH ($nodeDir) - effective after terminal/Claude Code restart" -ForegroundColor Green
    } catch {
      Write-Host "[WARN] Failed to write User PATH: $_ (non-fatal; start.cmd has fallback)" -ForegroundColor Yellow
    }
  }
}

# --- sqlite3 自動裝（v1.17.14，Tier 2 Cursor/Antigravity/OpenCode 需要）---
# Windows 預設沒 sqlite3 CLI → Cursor/Antigravity/OpenCode usage 永遠收不到。
# 用 winget（Windows 10 1809+ 內建 App Installer）自動裝；裝失敗走 fallback。
if (-not (Get-Command sqlite3 -ErrorAction SilentlyContinue)) {
  Write-Host "[WARN] sqlite3 not found (required by Tier 2 usage scanner)" -ForegroundColor Yellow
  $hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
  if ($hasWinget) {
    Write-Host "[INFO] Auto-installing SQLite.SQLite via winget"
    try {
      winget install --id SQLite.SQLite --scope user --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "[ OK ] sqlite3 installed (reopen terminal for PATH; next scanner run enables Tier 2)" -ForegroundColor Green
      } else {
        Write-Host "[WARN] winget install returned exit=$LASTEXITCODE; install manually then reopen terminal" -ForegroundColor Yellow
      }
    } catch {
      Write-Host "[WARN] winget install failed: $_" -ForegroundColor Yellow
    }
  } else {
    Write-Host "[WARN] winget unavailable; download sqlite-tools-win-x64 from https://www.sqlite.org/download.html and add to PATH" -ForegroundColor Yellow
  }
  Write-Host "       Skipping does not affect Claude Code / Codex usage; only Tier 2 (Cursor / Antigravity / OpenCode) session counts are unavailable" -ForegroundColor Gray
}

# --- Write-Utf8NoBom helper (v1.17.12, 回報者 Adam/Eric root cause) ---
# PS 5.1 的 `Set-Content -Encoding UTF8` 會加 UTF-8 BOM (EF BB BF)，下游 Node
# JSON.parse / /bin/sh / cmd 讀到 BOM 直接爆。統一用 [System.IO.File]::WriteAllText
# 寫 BOM-less UTF-8。注意該 API 只接受絕對路徑 — 所以內部 Resolve-Path。
function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $full = [System.IO.Path]::GetFullPath($Path)
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($full, $Content, $utf8NoBom)
}

# --- Copy-AsLf helper (v1.17.15, 回報者 Eric) ---
# Windows git checkout 在 core.autocrlf=true 時會把 LF 轉 CRLF。我們的 sh hook 一旦
# 變 CRLF，shebang `#!/bin/sh\r` 找不到 `/bin/sh\r` 這支 → "Exec format error"。
# 從 source 讀 bytes、過濾 0x0D（CR）、無 BOM 寫出，保證 LF on disk。
# .gitattributes 已強制 hook 檔 eol=lf，這個 helper 是雙重保險（防 user 手動編輯後存 CRLF）。
function Copy-AsLf {
  param([string]$Src, [string]$Dest)
  if (-not (Test-Path $Src)) { return $false }
  $srcBytes = [System.IO.File]::ReadAllBytes($Src)
  $cleanBytes = New-Object System.Collections.Generic.List[byte]
  foreach ($b in $srcBytes) {
    if ($b -ne 0x0D) { $cleanBytes.Add($b) }
  }
  $destFull = [System.IO.Path]::GetFullPath($Dest)
  [System.IO.File]::WriteAllBytes($destFull, $cleanBytes.ToArray())
  return $true
}

# --- Test-ShAvailable (v1.17.15, 回報者 Eric) ---
# Windows git 跑 sh hook 必須能 spawn sh.exe。Git for Windows 自帶在 usr\bin\，
# 但 VS Code Bundled Git / Microsoft.Git (WinGet) / Scoop git-with-openssh 都沒。
# 沒 sh.exe 時，git hook 會回 "Exec format error"。
function Test-ShAvailable {
  $sh = Get-Command sh.exe -ErrorAction SilentlyContinue
  if ($sh) { return $sh.Path }
  # Fallback：Git for Windows 典型路徑
  $gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($gitCmd) {
    $gitDir = Split-Path -Parent $gitCmd.Path
    # Git for Windows 真實佈局：cmd\git.exe + usr\bin\sh.exe（無 ..\bin\sh.exe）
    $candidates = @(
      (Join-Path $gitDir "..\usr\bin\sh.exe"),
      (Join-Path $gitDir "sh.exe")
    )
    foreach ($c in $candidates) {
      if (Test-Path $c) { return (Resolve-Path $c).Path }
    }
  }
  return $null
}

# --- 提前建立所有需要的目錄 ---
$OwnmindDir     = Join-Path $HOME ".ownmind"
$ClaudeDir       = Join-Path $HOME ".claude"
$ClaudeSettings  = Join-Path $ClaudeDir "settings.json"
$ClaudeMd        = Join-Path $ClaudeDir "CLAUDE.md"
$SkillDir        = Join-Path $ClaudeDir "skills\ownmind-memory"
$HookDir         = Join-Path $ClaudeDir "hooks"

foreach ($dir in @($ClaudeDir, $SkillDir, $HookDir)) {
  New-Item -ItemType Directory -Force -Path $dir -ErrorAction SilentlyContinue | Out-Null
}

# --- 1. Clone MCP Server ---
if (Test-Path $OwnmindDir) {
  Write-Host "[INFO] Updating OwnMind MCP server"
  git -C $OwnmindDir pull -q
  if ($LASTEXITCODE -ne 0) {
    Maybe-LoadReportError
    Report-Error -Kind "install_git_pull_failed" -Detail "git pull 失敗於 $OwnmindDir"
    Write-Error "git pull failed. Run bootstrap or fix manually and retry"
    exit 1
  }
} else {
  Write-Host "[INFO] Cloning OwnMind MCP server"
  git clone -q https://github.com/miou1107/ownmind.git $OwnmindDir
  if ($LASTEXITCODE -ne 0) {
    Report-Error -Kind "install_git_clone_failed" -Detail "git clone github.com/miou1107/ownmind 失敗"
    Write-Error "git clone failed (network or GitHub access)"
    exit 1
  }
}
Maybe-LoadReportError

Write-Host "[INFO] Installing dependencies"
Push-Location (Join-Path $OwnmindDir "mcp")
npm install -q 2>$null
if ($LASTEXITCODE -ne 0) {
  Pop-Location
  Report-Error -Kind "install_npm_failed" -Detail "npm install 在 $OwnmindDir\mcp 失敗"
  Write-Error "npm install failed. Try: npm install -g npm@latest and retry"
  exit 1
}
Pop-Location

# --- 決定 MCP 啟動方式（Windows 用 cmd.exe + start.cmd）---
$StartCmd = Join-Path $OwnmindDir "mcp\start.cmd"
$McpConfig = @{
  command = "cmd.exe"
  args    = @("/c", $StartCmd)
  env     = @{
    OWNMIND_API_URL = $ApiUrl
    OWNMIND_API_KEY = $ApiKey
    OWNMIND_TOOL    = "claude-code"
  }
}

# --- 2. Claude Code MCP 設定 ---
if (Test-Path $ClaudeSettings) {
  $content = Get-Content $ClaudeSettings -Raw
  if ($content -match '"ownmind"') {
    Write-Host "[INFO] Claude Code MCP already configured, skipping"
  } else {
    Write-Host "[INFO] Configuring Claude Code MCP"
    $settings = $content | ConvertFrom-Json
    if (-not $settings.mcpServers) {
      $settings | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
    }
    $settings.mcpServers | Add-Member -NotePropertyName ownmind -NotePropertyValue ([pscustomobject]$McpConfig) -Force
    Write-Utf8NoBom -Path $ClaudeSettings -Content ($settings | ConvertTo-Json -Depth 10)
  }
} else {
  Write-Host "[INFO] Creating Claude Code MCP config"
  Write-Utf8NoBom -Path $ClaudeSettings -Content (@{ mcpServers = @{ ownmind = $McpConfig } } | ConvertTo-Json -Depth 10)
}

# --- 2.1 v1.17.71 OwnMind 在場感：加 PostToolUse hook 把 banner 印到 user terminal ---
# 用同一支跨平台 Node helper（idempotent + backup + atomic）。
$AddHookHelper = Join-Path $OwnmindDir "scripts\install-helpers\add-post-tool-use-hook.cjs"
if (Test-Path $AddHookHelper) {
  $hookResult = & node $AddHookHelper $ClaudeSettings --ownmind-dir $OwnmindDir 2>&1
  Write-Host "   PostToolUse banner hook：$hookResult"
}

# --- 2.2 v1.17.96 IR-037/IR-036 邏輯卡控：加 Stop hook 跑 reply-lint ---
# 每輪 AI 回話結束自動掃中英混雜 + 行話沒附白話說明、違反就印 banner 到 terminal
$AddStopHookHelper = Join-Path $OwnmindDir "scripts\install-helpers\add-stop-hook.cjs"
if (Test-Path $AddStopHookHelper) {
  $stopHookResult = & node $AddStopHookHelper $ClaudeSettings --ownmind-dir $OwnmindDir 2>&1
  Write-Host "   Stop reply-lint hook：$stopHookResult"
}

# --- 3. CLAUDE.md 加入 OwnMind 引用 ---
$OwnmindBlock = @(
  "",
  "# OwnMind 個人記憶系統",
  "",
  "OwnMind 記憶透過 SessionStart hook 自動載入（不需手動呼叫 ownmind_init）。",
  "如果 context 中沒有看到【OwnMind vX.X.X】標記，手動呼叫 ownmind_init MCP tool。",
  "鐵律必須嚴格遵守。衝突時以 OwnMind 為準。存取記憶時顯示【OwnMind vX.X.X】{類型}：{內容} 格式標記。",
  "觸發詞：「記起來」「學起來」「新增鐵律」「交接」「整理記憶」。"
) -join "`n"

if (Test-Path $ClaudeMd) {
  $existing = Get-Content $ClaudeMd -Raw
  if ($existing -match "OwnMind") {
    Write-Host "[INFO] CLAUDE.md already references OwnMind, skipping"
  } else {
    Write-Host "[INFO] Updating CLAUDE.md"
    Write-Utf8NoBom -Path $ClaudeMd -Content ($existing + $OwnmindBlock)
  }
} else {
  Write-Host "[INFO] Creating CLAUDE.md"
  Write-Utf8NoBom -Path $ClaudeMd -Content $OwnmindBlock
}

# --- 4. 安裝 Skill ---
Copy-Item (Join-Path $OwnmindDir "skills\ownmind-memory.md") (Join-Path $SkillDir "SKILL.md") -Force
Write-Host "[ OK ] Installed ownmind-memory skill"

# --- 4b. 安裝 Hook Scripts（bash + node fallback）---
$BashHooks = @("ownmind-iron-rule-check.sh", "ownmind-session-start.sh", "ownmind-worktree-setup.sh")
foreach ($hook in $BashHooks) {
  $src = Join-Path $OwnmindDir "hooks\$hook"
  if (Test-Path $src) { Copy-Item $src $HookDir -Force }
}
# Node.js hooks for Windows (no bash/WSL required)
$NodeHooks = @("ownmind-iron-rule-check.js", "ownmind-session-start.js")
foreach ($hook in $NodeHooks) {
  $src = Join-Path $OwnmindDir "hooks\$hook"
  if (Test-Path $src) { Copy-Item $src $HookDir -Force }
}
Write-Host "[ OK ] Installed hook scripts"

# --- 4c. 加入 Hook 設定（SessionStart + PreToolUse）---
# 偵測是否有 bash（WSL / Git Bash）
$HasBash = $null -ne (Get-Command bash -ErrorAction SilentlyContinue)

$settingsContent = Get-Content $ClaudeSettings -Raw
$hookSettings = $settingsContent | ConvertFrom-Json
if (-not $hookSettings.hooks) {
  $hookSettings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
}

# SessionStart hook
if (-not $hookSettings.hooks.SessionStart) {
  $hookSettings.hooks | Add-Member -NotePropertyName SessionStart -NotePropertyValue @()
}
$sessionExists = $hookSettings.hooks.SessionStart | Where-Object {
  $_.hooks | Where-Object { $_.command -match "ownmind" }
}
if (-not $sessionExists) {
  if ($HasBash) {
    $sessionCmd = "bash ~/.claude/hooks/ownmind-session-start.sh"
  } else {
    $sessionCmd = "node `"$($HookDir -replace '\\','/')/ownmind-session-start.js`""
  }
  $newSessionHook = [pscustomobject]@{
    hooks = @([pscustomobject]@{ type = "command"; command = $sessionCmd; timeout = 10 })
  }
  $hookSettings.hooks.SessionStart += $newSessionHook
  Write-Host "[ OK ] Added SessionStart hook"
}

# PreToolUse hook
if (-not $hookSettings.hooks.PreToolUse) {
  $hookSettings.hooks | Add-Member -NotePropertyName PreToolUse -NotePropertyValue @()
}
$preExists = $hookSettings.hooks.PreToolUse | Where-Object {
  $_.hooks | Where-Object { $_.command -match "ownmind" }
}
if (-not $preExists) {
  if ($HasBash) {
    $preCmd = "bash ~/.claude/hooks/ownmind-iron-rule-check.sh"
  } else {
    $preCmd = "node `"$($HookDir -replace '\\','/')/ownmind-iron-rule-check.js`""
  }
  $newPreHook = [pscustomobject]@{
    matcher = "Bash"
    hooks   = @([pscustomobject]@{ type = "command"; command = $preCmd })
  }
  $hookSettings.hooks.PreToolUse += $newPreHook
  Write-Host "[ OK ] Added PreToolUse hook"
}

Write-Utf8NoBom -Path $ClaudeSettings -Content ($hookSettings | ConvertTo-Json -Depth 10)

# --- 4d. 安裝 Git Hooks（Iron Rule Verification Engine）---
Write-Host "[INFO] Installing Git hooks (Iron Rule Verification Engine)"

# 建立所需目錄
$GitHookDirs = @(
  (Join-Path $HOME ".ownmind\shared"),
  (Join-Path $HOME ".ownmind\cache"),
  (Join-Path $HOME ".ownmind\logs"),
  (Join-Path $HOME ".ownmind\git-hooks"),
  (Join-Path $HOME ".ownmind\hooks")
)
foreach ($dir in $GitHookDirs) {
  New-Item -ItemType Directory -Force -Path $dir -ErrorAction SilentlyContinue | Out-Null
}

# Helper：src 跟 destDir\<leaf> 同路徑時就 skip copy
# （install.sh 用 `-ef` 比 inode；PS 改比 GetFullPath 解析後字串）
# v1.17.10 修 Adam 回報的 "Copy-Item cannot overwrite with itself ×4"
function Copy-IfDifferent {
  param([string]$Src, [string]$DestDir, [string]$Label)
  if (-not (Test-Path $Src)) { return }
  $leaf = Split-Path $Src -Leaf
  $dstPath = Join-Path $DestDir $leaf
  $srcFull = [System.IO.Path]::GetFullPath($Src)
  $dstFull = [System.IO.Path]::GetFullPath($dstPath)
  if ($srcFull -ieq $dstFull) {
    Write-Host "[INFO] $Label already at destination (git clone), skipping"
    return
  }
  Copy-Item $Src $DestDir -Force
  Write-Host "[INFO] Copied $Label"
}

# 複製 verification engine
$VerificationSrc = Join-Path $OwnmindDir "shared\verification.js"
Copy-IfDifferent -Src $VerificationSrc -DestDir (Join-Path $HOME ".ownmind\shared\") -Label "verification engine"

# 複製 git hook JS 檔案
$GitHookJsFiles = @("ownmind-git-pre-commit.js", "ownmind-git-post-commit.js", "ownmind-verify-trigger.js")
foreach ($jsFile in $GitHookJsFiles) {
  $src = Join-Path $OwnmindDir "hooks\$jsFile"
  Copy-IfDifferent -Src $src -DestDir (Join-Path $HOME ".ownmind\hooks\") -Label $jsFile
}

# Windows: 安裝 sh wrapper（與 Mac/Linux 對齊；含 chain existing hooks 邏輯）
# 實作改點（v1.17.15, 回報者 Eric）：
# 1. 不再 inline 生 wrapper 內容（缺 chain 邏輯），改 copy source（hooks/ownmind-git-{pre,post}-commit）
# 2. Copy-AsLf 強制 LF 行尾，防 Windows core.autocrlf 把 sh script 轉 CRLF 導致 "Exec format error"
# 3. 偵測 sh.exe（Git for Windows 才有）；找不到時 fail-fast 並提示安裝來源
$PreCommitBat = Join-Path $HOME ".ownmind\git-hooks\pre-commit"
$PostCommitBat = Join-Path $HOME ".ownmind\git-hooks\post-commit"
$CommitMsgBat = Join-Path $HOME ".ownmind\git-hooks\commit-msg"
$PreCommitSrc = Join-Path $OwnmindDir "hooks\ownmind-git-pre-commit"
$PostCommitSrc = Join-Path $OwnmindDir "hooks\ownmind-git-post-commit"
$CommitMsgSrc = Join-Path $OwnmindDir "hooks\ownmind-git-commit-msg"

# 偵測 sh.exe（Git for Windows 自帶）
$shPath = Test-ShAvailable
if (-not $shPath) {
  Write-Host '[WARN] sh.exe not found - git hooks cannot run ("Exec format error")' -ForegroundColor Yellow
  Write-Host "       Cause: your git is not Git for Windows (VS Code bundled / WinGet Microsoft.Git / Scoop git-minimal do not ship sh.exe)" -ForegroundColor Yellow
  Write-Host "       Fix:   install Git for Windows -> https://git-scm.com/download/win" -ForegroundColor Yellow
  Write-Host "       Skipping git hooks install" -ForegroundColor Yellow
} else {
  Write-Host "[INFO] sh.exe detected: $shPath" -ForegroundColor Gray
  if (Copy-AsLf -Src $PreCommitSrc -Dest $PreCommitBat) {
    Write-Host "[ OK ] Installed git pre-commit hook (LF)"
  } else {
    Write-Host "[WARN] source not found: $PreCommitSrc, skipping pre-commit hook" -ForegroundColor Yellow
  }
  if (Copy-AsLf -Src $PostCommitSrc -Dest $PostCommitBat) {
    Write-Host "[ OK ] Installed git post-commit hook (LF)"
  } else {
    Write-Host "[WARN] source not found: $PostCommitSrc, skipping post-commit hook" -ForegroundColor Yellow
  }
  if (Copy-AsLf -Src $CommitMsgSrc -Dest $CommitMsgBat) {
    Write-Host "[ OK ] Installed git commit-msg hook (LF) (IR-024)"
  } else {
    Write-Host "[WARN] source not found: $CommitMsgSrc, skipping commit-msg hook" -ForegroundColor Yellow
  }

  # 設定 global git hooks path（只有 sh.exe 可用時才設，不然會壞所有 commit）
  $gitHooksPath = Join-Path $HOME ".ownmind\git-hooks"
  git config --global core.hooksPath $gitHooksPath
  Write-Host "[ OK ] Set git global hooks path: $gitHooksPath"
}

# --- 5. Cursor 設定（如果有 .cursor 目錄）---
$CursorDir = Join-Path $HOME ".cursor"
$CursorMcp = Join-Path $CursorDir "mcp.json"
if ((Test-Path $CursorDir) -or (Get-Command cursor -ErrorAction SilentlyContinue)) {
  New-Item -ItemType Directory -Force -Path $CursorDir | Out-Null
  if (Test-Path $CursorMcp) {
    $content = Get-Content $CursorMcp -Raw
    if ($content -match '"ownmind"') {
      Write-Host "[INFO] Cursor MCP already configured, skipping"
    } else {
      Write-Host "[INFO] Configuring Cursor MCP"
      $cursorSettings = $content | ConvertFrom-Json
      if (-not $cursorSettings.mcpServers) {
        $cursorSettings | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
      }
      $cursorSettings.mcpServers | Add-Member -NotePropertyName ownmind -NotePropertyValue ([pscustomobject]$McpConfig) -Force
      Write-Utf8NoBom -Path $CursorMcp -Content ($cursorSettings | ConvertTo-Json -Depth 10)
    }
  } else {
    Write-Host "[INFO] Configuring Cursor MCP"
    Write-Utf8NoBom -Path $CursorMcp -Content (@{ mcpServers = @{ ownmind = $McpConfig } } | ConvertTo-Json -Depth 10)
  }
}

# --- Always-on Usage Scanner（P6）---
# Opt-out：~/.ownmind/.no-usage-scanner 存在 → 跳過
$NoScannerFlag = Join-Path $OwnmindDir '.no-usage-scanner'
if (Test-Path $NoScannerFlag) {
  Write-Host "[INFO] Skipping usage scanner install (.no-usage-scanner opt-out)"
} else {
  Write-Host "[INFO] Installing usage scanner"
  # Scanner entry 已隨 repo clone 到 $OwnmindDir\hooks\ownmind-usage-scanner.js
  # 註冊 Task Scheduler（被呼叫腳本內建 node 偵測 + v20+ 驗證 + .node-path 快取）
  $RegisterScript = Join-Path $OwnmindDir 'scripts\windows\register-scanner-task.ps1'
  if (Test-Path $RegisterScript) {
    # v1.17.12 驗 exit code + Get-ScheduledTask（避免 silent fail）。
    # v1.17.67 IR-038：Tee stdout+stderr 到 log，self-check 會上傳給 admin 看根因。
    # logs 目錄已在 line 270-280 隨 $GitHookDirs 建好。
    $RegisterLogPath = Join-Path $OwnmindDir ('logs\register-task-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
    & powershell -ExecutionPolicy Bypass -File $RegisterScript 2>&1 |
      Tee-Object -FilePath $RegisterLogPath
    $regExit = $LASTEXITCODE
    $taskOk = $null -ne (Get-ScheduledTask -TaskName 'OwnMind Usage Scanner' -ErrorAction SilentlyContinue)
    if ($regExit -eq 0 -and $taskOk) {
      Write-Host "[ OK ] Task Scheduler registered (runs every 120 min)" -ForegroundColor Green
    } else {
      Write-Host "[WARN] Task Scheduler registration failed (exit=$regExit, task_exists=$taskOk)" -ForegroundColor Yellow
      Write-Host "       Error log: $RegisterLogPath" -ForegroundColor Yellow
      Write-Host "       self-check will upload the log so admin can see root cause" -ForegroundColor Yellow
      Write-Host "       Manual retry:" -ForegroundColor Yellow
      Write-Host "     powershell -ExecutionPolicy Bypass -File $RegisterScript" -ForegroundColor Yellow
    }
  } else {
    Write-Host "[WARN] register-scanner-task.ps1 not found; run manually" -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "OwnMind installation complete" -ForegroundColor Green
Write-Host ""
Write-Host "   MCP Server: $OwnmindDir\mcp\index.js"
Write-Host "   API URL:    $ApiUrl"
Write-Host "   API Key:    $($ApiKey.Substring(0,4))****$($ApiKey.Substring($ApiKey.Length-4))"
Write-Host "   Launch:     cmd.exe + start.cmd (Windows compatible)"
if (-not $HasBash) {
  Write-Host "   Hooks:      executed via Node.js (bash not detected)" -ForegroundColor Yellow
}
Write-Host "   Git Hooks:  pre-commit + post-commit（Iron Rule Verification）"
Write-Host ""

# v1.17.63: self-check 把所有元件真實狀態抓下來、寫 log + 上傳
# 包 try/catch：若 user 的 $ErrorActionPreference=Stop，沒包會中斷後面的安裝完成訊息
$SelfCheckScript = Join-Path $OwnmindDir 'scripts\install-helpers\self-check.cjs'
if (Test-Path $SelfCheckScript) {
  try { & node $SelfCheckScript --trigger=post_install } catch { }
}

Write-Host "Open a new Claude Code session - OwnMind will auto-load your memory."
Write-Host ""
