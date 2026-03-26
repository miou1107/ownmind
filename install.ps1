# OwnMind 一鍵安裝腳本（Windows PowerShell 原生版）
# 用法: .\install.ps1 YOUR_API_KEY
# 或: irm https://raw.githubusercontent.com/miou1107/ownmind/main/install.ps1 | iex  (需先設定 API_KEY 環境變數)

param(
  [Parameter(Position=0)]
  [string]$ApiKey = $env:OWNMIND_API_KEY
)

if (-not $ApiKey) {
  Write-Error "❌ 請提供 API Key`n用法: .\install.ps1 YOUR_API_KEY"
  exit 1
}

Write-Host "🧠 OwnMind 安裝中..." -ForegroundColor Cyan

# --- 檢查必要工具 ---
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error "❌ 找不到 git，請先安裝 Git for Windows"
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "❌ 找不到 node，請先安裝 Node.js"
  exit 1
}

# --- 1. Clone MCP Server ---
$OwnmindDir = Join-Path $HOME ".ownmind"
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
    OWNMIND_API_URL = "https://kkvin.com/ownmind"
    OWNMIND_API_KEY = $ApiKey
  }
}

# --- 2. Claude Code MCP 設定 ---
$ClaudeDir      = Join-Path $HOME ".claude"
$ClaudeSettings = Join-Path $ClaudeDir "settings.json"
New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null

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
$ClaudeMd = Join-Path $ClaudeDir "CLAUDE.md"
$OwnmindBlock = @"

# OwnMind 個人記憶系統

你已連接 OwnMind 跨平台 AI 個人記憶系統。

## 必須遵守
- 開始工作時，呼叫 ownmind_init 載入使用者記憶
- 個人偏好、鐵律、專案 context 以 OwnMind 為主要來源（跨平台共享）
- 本地 memory 可並存，但發生衝突時以 OwnMind 為準
- 存取記憶時必須顯示【OwnMind】提示（詳見 ownmind-memory skill）
- 完成重要工作後，主動儲存記憶
- 交接工作時，使用 OwnMind 交接機制

## 觸發詞
- 「記起來」「學起來」「新增鐵律」→ 儲存記憶
- 「交接給 XXX」→ 建立交接
- 「整理記憶」「我有哪些記憶」→ 查詢記憶
"@

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
$SkillDir = Join-Path $ClaudeDir "skills\ownmind-memory"
New-Item -ItemType Directory -Force -Path $SkillDir | Out-Null
Copy-Item (Join-Path $OwnmindDir "skills\ownmind-memory.md") (Join-Path $SkillDir "SKILL.md") -Force
Write-Host "   安裝 ownmind-memory skill"

# --- 4b. 安裝 Hook Script ---
$HookDir = Join-Path $ClaudeDir "hooks"
New-Item -ItemType Directory -Force -Path $HookDir | Out-Null
Copy-Item (Join-Path $OwnmindDir "hooks\ownmind-iron-rule-check.sh") $HookDir -Force
Write-Host "   安裝 ownmind-iron-rule-check hook"

# --- 4c. 加入 PreToolUse hook 設定 ---
$settingsContent = Get-Content $ClaudeSettings -Raw
$settings = $settingsContent | ConvertFrom-Json
if (-not $settings.hooks) {
  $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
}
if (-not $settings.hooks.PreToolUse) {
  $settings.hooks | Add-Member -NotePropertyName PreToolUse -NotePropertyValue @()
}
$hookExists = $settings.hooks.PreToolUse | Where-Object {
  $_.hooks | Where-Object { $_.command -match "ownmind-iron-rule-check" }
}
if (-not $hookExists) {
  $newHook = [pscustomobject]@{
    matcher = "Bash"
    hooks   = @([pscustomobject]@{ type = "command"; command = "bash ~/.claude/hooks/ownmind-iron-rule-check.sh" })
  }
  $settings.hooks.PreToolUse += $newHook
  $settings | ConvertTo-Json -Depth 10 | Set-Content $ClaudeSettings -Encoding UTF8
  Write-Host "   加入 PreToolUse hook 設定"
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
      $settings = $content | ConvertFrom-Json
      if (-not $settings.mcpServers) {
        $settings | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
      }
      $settings.mcpServers | Add-Member -NotePropertyName ownmind -NotePropertyValue ([pscustomobject]$McpConfig) -Force
      $settings | ConvertTo-Json -Depth 10 | Set-Content $CursorMcp -Encoding UTF8
    }
  } else {
    Write-Host "   設定 Cursor MCP..."
    @{ mcpServers = @{ ownmind = $McpConfig } } | ConvertTo-Json -Depth 10 | Set-Content $CursorMcp -Encoding UTF8
  }
}

Write-Host ""
Write-Host "✅ OwnMind 安裝完成！" -ForegroundColor Green
Write-Host ""
Write-Host "   MCP Server: $OwnmindDir\mcp\index.js"
Write-Host "   API URL:    https://kkvin.com/ownmind"
Write-Host "   API Key:    $ApiKey"
Write-Host "   啟動方式:   cmd.exe + start.cmd（Windows 相容）"
Write-Host ""
Write-Host "   現在開一個新的 Claude Code 對話，說「載入我的 OwnMind」即可開始！"
Write-Host ""
