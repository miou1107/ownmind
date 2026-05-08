# OwnMind 一鍵安裝腳本（Windows PowerShell 原生版）
# 用法: .\install.ps1 YOUR_API_KEY YOUR_API_URL
# 或: $env:OWNMIND_API_KEY='xxx'; $env:OWNMIND_API_URL='https://your-server.com/ownmind'; irm https://raw.githubusercontent.com/miou1107/ownmind/main/install.ps1 | iex

# --- 環境正規化（v1.17.9, 回報者 Adam）---
# 從 Git Bash / MSYS / Cygwin 呼叫 powershell 時，$HOME 會是 POSIX 格式 /c/Users/xxx，
# 跟 Windows path 串接變 C:\c\Users\xxx 怪路徑。強制把 $HOME 指向 $env:USERPROFILE。
if ($env:USERPROFILE -and ($HOME -ne $env:USERPROFILE)) {
  Set-Variable -Name HOME -Value $env:USERPROFILE -Force -Scope Global -ErrorAction SilentlyContinue
}

# --- 參數處理（同時支援 param 和環境變數，irm | iex 不支援 param）---
# 過濾 flag-like args（如舊版 interactive-upgrade.ps1 傳的 --update），避免被當 API key
$PosArgs = @($args | Where-Object { $_ -notlike '-*' })
if ($PosArgs.Count -ge 1) { $ApiKey = $PosArgs[0] } else { $ApiKey = $env:OWNMIND_API_KEY }
if ($PosArgs.Count -ge 2) { $ApiUrl = $PosArgs[1] } else { $ApiUrl = $env:OWNMIND_API_URL }

if (-not $ApiKey) {
  Write-Error "請提供 API Key`n用法: .\install.ps1 YOUR_API_KEY YOUR_API_URL`n或設定環境變數: `$env:OWNMIND_API_KEY='xxx'; `$env:OWNMIND_API_URL='https://...'"
  exit 1
}
if (-not $ApiUrl) {
  Write-Error "請提供 API URL`n用法: .\install.ps1 YOUR_API_KEY YOUR_API_URL"
  exit 1
}

Write-Host "OwnMind 安裝中..." -ForegroundColor Cyan

# --- 檢查必要工具 ---
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error "找不到 git，請先安裝 Git for Windows: https://git-scm.com/download/win"
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "找不到 node，請先安裝 Node.js: https://nodejs.org/"
  exit 1
}

# --- sqlite3 自動裝（v1.17.14，Tier 2 Cursor/Antigravity/OpenCode 需要）---
# Windows 預設沒 sqlite3 CLI → Cursor/Antigravity/OpenCode usage 永遠收不到。
# 用 winget（Windows 10 1809+ 內建 App Installer）自動裝；裝失敗走 fallback。
if (-not (Get-Command sqlite3 -ErrorAction SilentlyContinue)) {
  Write-Host "   未偵測到 sqlite3（Tier 2 usage scanner 需要）" -ForegroundColor Yellow
  $hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
  if ($hasWinget) {
    Write-Host "   嘗試用 winget 自動安裝 SQLite.SQLite..."
    try {
      winget install --id SQLite.SQLite --scope user --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "   sqlite3 已裝（重開 terminal 讓 PATH 生效；下次 scanner 自動啟用 Tier 2）" -ForegroundColor Green
      } else {
        Write-Host "   winget install 回傳 exit=$LASTEXITCODE；請手動裝後重開 terminal" -ForegroundColor Yellow
      }
    } catch {
      Write-Host "   winget install 失敗：$_" -ForegroundColor Yellow
    }
  } else {
    Write-Host "   無 winget；請到 https://www.sqlite.org/download.html 下載 sqlite-tools-win-x64 並加入 PATH" -ForegroundColor Yellow
  }
  Write-Host "   不裝 sqlite3 不影響 Claude Code / Codex 主要 usage，只是 Tier 2（Cursor / Antigravity / OpenCode）session 計數不會收集" -ForegroundColor Gray
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
  Write-Host "   更新 OwnMind MCP Server..."
  git -C $OwnmindDir pull -q
} else {
  Write-Host "   下載 OwnMind MCP Server..."
  git clone -q https://github.com/miou1107/ownmind.git $OwnmindDir
}

Write-Host "   安裝依賴..."
Push-Location (Join-Path $OwnmindDir "mcp")
npm install -q 2>$null
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
    Write-Host "   Claude Code MCP 已設定，跳過"
  } else {
    Write-Host "   設定 Claude Code MCP..."
    $settings = $content | ConvertFrom-Json
    if (-not $settings.mcpServers) {
      $settings | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
    }
    $settings.mcpServers | Add-Member -NotePropertyName ownmind -NotePropertyValue ([pscustomobject]$McpConfig) -Force
    Write-Utf8NoBom -Path $ClaudeSettings -Content ($settings | ConvertTo-Json -Depth 10)
  }
} else {
  Write-Host "   建立 Claude Code MCP 設定..."
  Write-Utf8NoBom -Path $ClaudeSettings -Content (@{ mcpServers = @{ ownmind = $McpConfig } } | ConvertTo-Json -Depth 10)
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
    Write-Host "   CLAUDE.md 已包含 OwnMind，跳過"
  } else {
    Write-Host "   更新 CLAUDE.md..."
    Write-Utf8NoBom -Path $ClaudeMd -Content ($existing + $OwnmindBlock)
  }
} else {
  Write-Host "   建立 CLAUDE.md..."
  Write-Utf8NoBom -Path $ClaudeMd -Content $OwnmindBlock
}

# --- 4. 安裝 Skill ---
Copy-Item (Join-Path $OwnmindDir "skills\ownmind-memory.md") (Join-Path $SkillDir "SKILL.md") -Force
Write-Host "   安裝 ownmind-memory skill"

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
Write-Host "   安裝 hook scripts"

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
  Write-Host "   加入 SessionStart hook"
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
  Write-Host "   加入 PreToolUse hook"
}

Write-Utf8NoBom -Path $ClaudeSettings -Content ($hookSettings | ConvertTo-Json -Depth 10)

# --- 4d. 安裝 Git Hooks（Iron Rule Verification Engine）---
Write-Host "   安裝 Git Hooks（Iron Rule Verification Engine）..."

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
    Write-Host "   $Label 已在目標位置（git clone），略過"
    return
  }
  Copy-Item $Src $DestDir -Force
  Write-Host "   複製 $Label"
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
  Write-Host '   ⚠️ 找不到 sh.exe — git hook 將無法執行（"Exec format error"）' -ForegroundColor Yellow
  Write-Host "      原因：你的 git 不是 Git for Windows（VS Code 內建 / WinGet Microsoft.Git / Scoop git-minimal 都沒帶 sh.exe）" -ForegroundColor Yellow
  Write-Host "      解法：安裝 Git for Windows → https://git-scm.com/download/win" -ForegroundColor Yellow
  Write-Host "      跳過 git hooks 安裝" -ForegroundColor Yellow
} else {
  Write-Host "   偵測 sh.exe: $shPath" -ForegroundColor Gray
  if (Copy-AsLf -Src $PreCommitSrc -Dest $PreCommitBat) {
    Write-Host "   安裝 git pre-commit hook（LF）"
  } else {
    Write-Host "   ⚠️ 找不到 source: $PreCommitSrc，跳過 pre-commit hook" -ForegroundColor Yellow
  }
  if (Copy-AsLf -Src $PostCommitSrc -Dest $PostCommitBat) {
    Write-Host "   安裝 git post-commit hook（LF）"
  } else {
    Write-Host "   ⚠️ 找不到 source: $PostCommitSrc，跳過 post-commit hook" -ForegroundColor Yellow
  }
  if (Copy-AsLf -Src $CommitMsgSrc -Dest $CommitMsgBat) {
    Write-Host "   安裝 git commit-msg hook（LF）(IR-024)"
  } else {
    Write-Host "   ⚠️ 找不到 source: $CommitMsgSrc，跳過 commit-msg hook" -ForegroundColor Yellow
  }

  # 設定 global git hooks path（只有 sh.exe 可用時才設，不然會壞所有 commit）
  $gitHooksPath = Join-Path $HOME ".ownmind\git-hooks"
  git config --global core.hooksPath $gitHooksPath
  Write-Host "   設定 git global hooks path: $gitHooksPath"
}

# --- 5. Cursor 設定（如果有 .cursor 目錄）---
$CursorDir = Join-Path $HOME ".cursor"
$CursorMcp = Join-Path $CursorDir "mcp.json"
if ((Test-Path $CursorDir) -or (Get-Command cursor -ErrorAction SilentlyContinue)) {
  New-Item -ItemType Directory -Force -Path $CursorDir | Out-Null
  if (Test-Path $CursorMcp) {
    $content = Get-Content $CursorMcp -Raw
    if ($content -match '"ownmind"') {
      Write-Host "   Cursor MCP 已設定，跳過"
    } else {
      Write-Host "   設定 Cursor MCP..."
      $cursorSettings = $content | ConvertFrom-Json
      if (-not $cursorSettings.mcpServers) {
        $cursorSettings | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
      }
      $cursorSettings.mcpServers | Add-Member -NotePropertyName ownmind -NotePropertyValue ([pscustomobject]$McpConfig) -Force
      Write-Utf8NoBom -Path $CursorMcp -Content ($cursorSettings | ConvertTo-Json -Depth 10)
    }
  } else {
    Write-Host "   設定 Cursor MCP..."
    Write-Utf8NoBom -Path $CursorMcp -Content (@{ mcpServers = @{ ownmind = $McpConfig } } | ConvertTo-Json -Depth 10)
  }
}

# --- Always-on Usage Scanner（P6）---
# Opt-out：~/.ownmind/.no-usage-scanner 存在 → 跳過
$NoScannerFlag = Join-Path $OwnmindDir '.no-usage-scanner'
if (Test-Path $NoScannerFlag) {
  Write-Host "   跳過 usage scanner 安裝（.no-usage-scanner opt-out）"
} else {
  Write-Host "   安裝 usage scanner..."
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
      Write-Host "   Task Scheduler 已註冊（每 120 分鐘執行）" -ForegroundColor Green
    } else {
      Write-Host "   Task Scheduler 註冊失敗 (exit=$regExit, task_exists=$taskOk)" -ForegroundColor Yellow
      Write-Host "   錯誤紀錄已寫入：$RegisterLogPath" -ForegroundColor Yellow
      Write-Host "   self-check 結尾會自動把 log 上傳，Vin 那邊可看到根因。" -ForegroundColor Yellow
      Write-Host "   手動重跑：" -ForegroundColor Yellow
      Write-Host "     powershell -ExecutionPolicy Bypass -File $RegisterScript" -ForegroundColor Yellow
    }
  } else {
    Write-Host "   找不到 register-scanner-task.ps1；請手動執行" -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "OwnMind 安裝完成！" -ForegroundColor Green
Write-Host ""
Write-Host "   MCP Server: $OwnmindDir\mcp\index.js"
Write-Host "   API URL:    $ApiUrl"
Write-Host "   API Key:    $($ApiKey.Substring(0,4))****$($ApiKey.Substring($ApiKey.Length-4))"
Write-Host "   啟動方式:   cmd.exe + start.cmd（Windows 相容）"
if (-not $HasBash) {
  Write-Host "   Hooks:      使用 Node.js 執行（未偵測到 bash）" -ForegroundColor Yellow
}
Write-Host "   Git Hooks:  pre-commit + post-commit（Iron Rule Verification）"
Write-Host ""

# v1.17.63: self-check 把所有元件真實狀態抓下來、寫 log + 上傳
# 包 try/catch：若 user 的 $ErrorActionPreference=Stop，沒包會中斷後面的安裝完成訊息
$SelfCheckScript = Join-Path $OwnmindDir 'scripts\install-helpers\self-check.cjs'
if (Test-Path $SelfCheckScript) {
  try { & node $SelfCheckScript --trigger=post_install } catch { }
}

Write-Host "   開一個新的 Claude Code 對話，OwnMind 會自動載入你的記憶！"
Write-Host ""
