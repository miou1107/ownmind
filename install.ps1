# OwnMind 一鍵安裝腳本（Windows PowerShell 原生版）
# 用法: .\install.ps1 YOUR_API_KEY YOUR_API_URL
# 或: $env:OWNMIND_API_KEY='xxx'; $env:OWNMIND_API_URL='https://your-server.com/ownmind'; irm https://raw.githubusercontent.com/miou1107/ownmind/main/install.ps1 | iex

# --- 參數處理（同時支援 param 和環境變數，irm | iex 不支援 param）---
if ($args.Count -ge 1) { $ApiKey = $args[0] } else { $ApiKey = $env:OWNMIND_API_KEY }
if ($args.Count -ge 2) { $ApiUrl = $args[1] } else { $ApiUrl = $env:OWNMIND_API_URL }

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
    $settings | ConvertTo-Json -Depth 10 | Set-Content $ClaudeSettings -Encoding UTF8
  }
} else {
  Write-Host "   建立 Claude Code MCP 設定..."
  @{ mcpServers = @{ ownmind = $McpConfig } } | ConvertTo-Json -Depth 10 | Set-Content $ClaudeSettings -Encoding UTF8
}

# --- 3. CLAUDE.md 加入 OwnMind 引用 ---
$OwnmindBlock = @(
  "",
  "# OwnMind 個人記憶系統",
  "",
  "OwnMind 記憶透過 SessionStart hook 自動載入（不需手動呼叫 ownmind_init）。",
  "如果 context 中沒有看到【OwnMind】標記，手動呼叫 ownmind_init MCP tool。",
  "鐵律必須嚴格遵守。衝突時以 OwnMind 為準。存取記憶時顯示【OwnMind】標記。",
  "觸發詞：「記起來」「學起來」「新增鐵律」「交接」「整理記憶」。"
) -join "`n"

if (Test-Path $ClaudeMd) {
  $existing = Get-Content $ClaudeMd -Raw
  if ($existing -match "OwnMind") {
    Write-Host "   CLAUDE.md 已包含 OwnMind，跳過"
  } else {
    Write-Host "   更新 CLAUDE.md..."
    Add-Content $ClaudeMd $OwnmindBlock -Encoding UTF8
  }
} else {
  Write-Host "   建立 CLAUDE.md..."
  Set-Content $ClaudeMd $OwnmindBlock -Encoding UTF8
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

$hookSettings | ConvertTo-Json -Depth 10 | Set-Content $ClaudeSettings -Encoding UTF8

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

# 複製 verification engine
$VerificationSrc = Join-Path $OwnmindDir "shared\verification.js"
if (Test-Path $VerificationSrc) {
  Copy-Item $VerificationSrc (Join-Path $HOME ".ownmind\shared\") -Force
  Write-Host "   複製 verification engine"
}

# 複製 git hook JS 檔案
$GitHookJsFiles = @("ownmind-git-pre-commit.js", "ownmind-git-post-commit.js", "ownmind-verify-trigger.js")
foreach ($jsFile in $GitHookJsFiles) {
  $src = Join-Path $OwnmindDir "hooks\$jsFile"
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $HOME ".ownmind\hooks\") -Force
    Write-Host "   複製 $jsFile"
  }
}

# Windows: 建立 bat wrapper 呼叫 node 執行 JS hooks
$PreCommitBat = Join-Path $HOME ".ownmind\git-hooks\pre-commit"
$PostCommitBat = Join-Path $HOME ".ownmind\git-hooks\post-commit"

$PreCommitJs = Join-Path $HOME ".ownmind\hooks\ownmind-git-pre-commit.js"
$PostCommitJs = Join-Path $HOME ".ownmind\hooks\ownmind-git-post-commit.js"

if (Test-Path (Join-Path $OwnmindDir "hooks\ownmind-git-pre-commit.js")) {
  @"
#!/bin/sh
node "$HOME/.ownmind/hooks/ownmind-git-pre-commit.js"
"@ | Set-Content $PreCommitBat -Encoding UTF8 -NoNewline
  Write-Host "   安裝 git pre-commit hook"
}

if (Test-Path (Join-Path $OwnmindDir "hooks\ownmind-git-post-commit.js")) {
  @"
#!/bin/sh
node "$HOME/.ownmind/hooks/ownmind-git-post-commit.js"
"@ | Set-Content $PostCommitBat -Encoding UTF8 -NoNewline
  Write-Host "   安裝 git post-commit hook"
}

# 設定 global git hooks path
if (Get-Command git -ErrorAction SilentlyContinue) {
  $gitHooksPath = Join-Path $HOME ".ownmind\git-hooks"
  git config --global core.hooksPath $gitHooksPath
  Write-Host "   設定 git global hooks path: $gitHooksPath"
} else {
  Write-Host "   找不到 git，跳過 global hooks path 設定" -ForegroundColor Yellow
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
      $cursorSettings | ConvertTo-Json -Depth 10 | Set-Content $CursorMcp -Encoding UTF8
    }
  } else {
    Write-Host "   設定 Cursor MCP..."
    @{ mcpServers = @{ ownmind = $McpConfig } } | ConvertTo-Json -Depth 10 | Set-Content $CursorMcp -Encoding UTF8
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
Write-Host "   開一個新的 Claude Code 對話，OwnMind 會自動載入你的記憶！"
Write-Host ""
