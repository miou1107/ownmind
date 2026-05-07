# OwnMind 自動更新腳本（Windows PowerShell 版）
# 在 git pull 後執行，同步 skill、hook、settings 到各工具目錄
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File ~/.ownmind/scripts/update.ps1
#
# 對應 scripts/update.sh，是 Windows MCP auto-update 流程的尾端 sync 步驟。
# v1.17.22 新增（修 Eric / Adam 卡舊版的根因）。

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

# Git Bash / MSYS 會把 $HOME 污染成 /c/Users/xxx，強制走 Windows USERPROFILE
if ($env:USERPROFILE -and ($HOME -ne $env:USERPROFILE)) {
  Set-Variable -Name HOME -Value $env:USERPROFILE -Force -Scope Global -ErrorAction SilentlyContinue
}

$OwnMindDir = Join-Path $HOME ".ownmind"
$ErrLog = Join-Path $OwnMindDir "logs\update-errors.log"
New-Item -ItemType Directory -Force -Path (Split-Path $ErrLog) | Out-Null

Write-Host "OwnMind 同步更新中（Windows）..."

function CopyIfExists {
  param([string]$Src, [string]$Dest)
  if (Test-Path $Src) {
    $destDir = Split-Path -Parent $Dest
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
    Copy-Item -Force -Path $Src -Destination $Dest
    return $true
  }
  return $false
}

# --- 1. Claude Code skills ---
$ClaudeDir = Join-Path $HOME ".claude"
if (Test-Path $ClaudeDir) {
  CopyIfExists `
    (Join-Path $OwnMindDir "skills\ownmind-memory.md") `
    (Join-Path $ClaudeDir "skills\ownmind-memory\SKILL.md") | Out-Null
  CopyIfExists `
    (Join-Path $OwnMindDir "skills\ownmind-upgrade.md") `
    (Join-Path $ClaudeDir "skills\ownmind-upgrade\SKILL.md") | Out-Null
  Write-Host "   skills 已更新（ownmind-memory + ownmind-upgrade）"
}

# --- 1b. 同步升級規則到其他 AI 工具 ---
$UpgradeSnippet = Join-Path $OwnMindDir "skills\ownmind-upgrade-agents-snippet.md"
if (Test-Path $UpgradeSnippet) {
  $snippet = Get-Content -Raw -Path $UpgradeSnippet
  function AppendRule {
    param([string]$TargetFile)
    $dir = Split-Path -Parent $TargetFile
    if (-not (Test-Path $dir)) { return }
    $marker = '<!-- ownmind-upgrade-rule -->'
    $endMarker = '<!-- /ownmind-upgrade-rule -->'
    $existing = if (Test-Path $TargetFile) {
      [regex]::Replace((Get-Content -Raw -Path $TargetFile),
        '<!--\s*ownmind-upgrade-rule\s*-->[\s\S]*?<!--\s*/ownmind-upgrade-rule\s*-->\r?\n?', '')
    } else { '' }
    $block = "`r`n$marker`r`n$($script:snippet)`r`n$endMarker`r`n"
    Set-Content -Path $TargetFile -Value ($existing.TrimEnd() + $block) -Encoding UTF8 -NoNewline
  }
  AppendRule (Join-Path $HOME ".codex\AGENTS.md")
  AppendRule (Join-Path $HOME ".cursor\rules\ownmind.md")
  AppendRule (Join-Path $HOME ".antigravity\rules\ownmind.md")
  AppendRule (Join-Path $HOME ".opencode\AGENTS.md")
  AppendRule (Join-Path $HOME ".windsurf\rules\ownmind.md")
  AppendRule (Join-Path $HOME ".gemini\GEMINI.md")
  Write-Host "   升級規則已同步到偵測到的 AI 工具"
}

# --- 2. hook scripts + lib（Git Bash 才能跑 .sh）---
if (Test-Path $ClaudeDir) {
  $HookDir = Join-Path $ClaudeDir "hooks"
  $HookLibDir = Join-Path $HookDir "lib"
  New-Item -ItemType Directory -Force -Path $HookLibDir | Out-Null
  Get-ChildItem -Path (Join-Path $OwnMindDir "hooks") -Filter "*.sh" -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item -Force -Path $_.FullName -Destination $HookDir }
  $LibSrc = Join-Path $OwnMindDir "hooks\lib"
  if (Test-Path $LibSrc) {
    Get-ChildItem -Path $LibSrc -Filter "*.js" -ErrorAction SilentlyContinue |
      ForEach-Object { Copy-Item -Force -Path $_.FullName -Destination $HookLibDir }
  }
  Write-Host "   hook scripts 已同步"
}

# --- 2b. usage scanner ---
$ScannerJs = Join-Path $OwnMindDir "hooks\ownmind-usage-scanner.js"
if (Test-Path $ScannerJs) { Write-Host "   usage scanner 已就緒" }

# --- 3. Claude Code settings.json：注入 hooks ---
$ClaudeSettings = Join-Path $ClaudeDir "settings.json"
$NoSessionFlag = Join-Path $OwnMindDir ".no-session-hook"
if (Test-Path $ClaudeSettings) {
  $nodeScript = @"
    const fs = require('fs');
    const settingsPath = process.argv[1];
    const noSessionHook = process.argv[2] === 'true';
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    let changed = false;
    if (!s.hooks) { s.hooks = {}; changed = true; }

    if (!noSessionHook) {
      if (!s.hooks.SessionStart) s.hooks.SessionStart = [];
      const ownmindCmd = 'bash ~/.claude/hooks/ownmind-session-start.sh';
      const isOwnmindEntry = h => h.hooks?.some(hh => (hh.command || '').includes('ownmind-session-start'));
      const existing = s.hooks.SessionStart.filter(isOwnmindEntry);
      const matchers = ['startup', 'resume', 'clear', 'compact'];
      const hasAll = matchers.every(m => existing.some(h => h.matcher === m));
      if (existing.length > 0 && !hasAll) {
        s.hooks.SessionStart = s.hooks.SessionStart.filter(h => !isOwnmindEntry(h));
        for (const matcher of matchers) {
          s.hooks.SessionStart.push({ matcher, hooks: [{ type: 'command', command: ownmindCmd, timeout: 10 }] });
        }
        changed = true;
      } else if (existing.length === 0 && s.hooks.SessionStart.length === 0) {
        for (const matcher of matchers) {
          s.hooks.SessionStart.push({ matcher, hooks: [{ type: 'command', command: ownmindCmd, timeout: 10 }] });
        }
        changed = true;
      }
    }

    if (!s.hooks.PreToolUse) s.hooks.PreToolUse = [];
    if (!s.hooks.PreToolUse.some(h => h.hooks?.some(hh => (hh.command || '').includes('ownmind-iron-rule-check')))) {
      s.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-iron-rule-check.sh' }] });
      changed = true;
    }

    if (!s.hooks.WorktreeCreate) s.hooks.WorktreeCreate = [];
    if (!s.hooks.WorktreeCreate.some(h => h.hooks?.some(hh => (hh.command || '').includes('ownmind-worktree-setup')))) {
      s.hooks.WorktreeCreate.push({ hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-worktree-setup.sh', timeout: 10 }] });
      changed = true;
    }

    if (changed) {
      const tmp = settingsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, settingsPath);
      console.log('   settings.json hooks 已更新');
    }
"@
  $tmpScript = Join-Path $env:TEMP "ownmind-update-settings.js"
  Set-Content -Path $tmpScript -Value $nodeScript -Encoding UTF8
  $noFlag = if (Test-Path $NoSessionFlag) { 'true' } else { 'false' }
  & node $tmpScript $ClaudeSettings $noFlag 2>>$ErrLog
  Remove-Item $tmpScript -ErrorAction SilentlyContinue
}

# --- 標記已安裝 ---
$null = New-Item -ItemType File -Force -Path (Join-Path $OwnMindDir ".session-hook-installed")

Write-Host "OwnMind 同步完成（Windows）"
