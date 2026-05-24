# OwnMind 同步更新腳本（Windows PowerShell 版）— light sync only
#
# ⚠️ 這支只做 skill / hook / settings 同步，**不是完整升級流程**。
#    要升級 OwnMind 版本請改跑：
#       powershell -ExecutionPolicy Bypass -File ~/.ownmind/scripts/bootstrap.ps1
#    bootstrap 會自動判斷 install / upgrade / repair 並走對應流程。
#
# 適用場景：git pull 後 / install.ps1 尾端，把 ~/.ownmind/ 內檔同步到各工具目錄。
# v1.17.22 新增（修 Eric / Adam 卡舊版的根因）。
# v1.17.81 修 StackOverflow + 加觀測管道（vin-windows-test 第五輪）：
#   - 4 處 @"..."@ heredoc 改 @'...'@ 單引號 — 雙引號會觸發 PS 對 JS code 內 $var 做展開，
#     某些路徑會遞迴展開 → StackOverflowException 整個 process 死。單引號完全 disable 展開。
#   - 加 update_started beacon + try/catch + report-error，跟 install / upgrade 同等觀測層級。

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

# Git Bash / MSYS 會把 $HOME 污染成 /c/Users/xxx，強制走 Windows USERPROFILE
if ($env:USERPROFILE -and ($HOME -ne $env:USERPROFILE)) {
  Set-Variable -Name HOME -Value $env:USERPROFILE -Force -Scope Global -ErrorAction SilentlyContinue
}

$OwnMindDir = Join-Path $HOME ".ownmind"
$ErrLog = Join-Path $OwnMindDir "logs\update-errors.log"
New-Item -ItemType Directory -Force -Path (Split-Path $ErrLog) | Out-Null

# v1.17.81 — 載入 report-error helper（IR-038 觀測管道）
$reportErrorHelper = Join-Path $OwnMindDir 'scripts\install-helpers\report-error.ps1'
if (Test-Path $reportErrorHelper) {
  . $reportErrorHelper
} else {
  function Report-Error { param($Kind, $Detail, $ContextFile = "") }
}

# v1.17.81 — update_started beacon（fire-and-forget，失敗 spool 同 v1.17.80 模式）
function Send-UpdateBeacon {
  param([string]$Trigger)
  $claudeSettings = Join-Path $HOME '.claude\settings.json'
  if (-not (Test-Path $claudeSettings)) { return }
  try {
    $cfg = Get-Content $claudeSettings -Raw | ConvertFrom-Json
    $env = $cfg.mcpServers.ownmind.env
    $apiKey = $env.OWNMIND_API_KEY
    $apiUrl = $env.OWNMIND_API_URL
    if (-not $apiKey -or -not $apiUrl) { return }
    $machine = try { [System.Net.Dns]::GetHostName() } catch { 'unknown' }
    $body = @{
      ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
      trigger = $Trigger
      client_version = 'update-script'
      platform = 'win32'
      machine = $machine
    } | ConvertTo-Json -Compress
    try {
      Invoke-RestMethod -Uri "$($apiUrl.TrimEnd('/'))/api/debug/install-check" `
        -Method POST `
        -Headers @{ Authorization = "Bearer $apiKey"; 'Content-Type' = 'application/json' } `
        -Body $body -TimeoutSec 5 -ErrorAction Stop | Out-Null
    } catch {
      # spool fallback
      try {
        $spoolFile = Join-Path $OwnMindDir 'logs\.upload-spool.jsonl'
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::AppendAllText($spoolFile, ($body + "`n"), $utf8NoBom)
      } catch { }
    }
  } catch { }
}
Send-UpdateBeacon -Trigger 'update_started'

Write-Host "OwnMind sync (light path)"
Write-Host "─────────────────────────────────────────────"

# --- 0. v1.18.5 補修：conditional-sync-cli.js 需要 js-yaml ---
# 對應 update.sh 的 root deps 修補。idempotent：已裝就 skip。
$JsYamlDir = Join-Path $OwnMindDir "node_modules\js-yaml"
if (-not (Test-Path $JsYamlDir)) {
  Write-Host "   📦 安裝 conditional-sync 缺的依賴 js-yaml..."
  Push-Location $OwnMindDir
  try {
    $errLog = Join-Path $env:USERPROFILE ".ownmind\logs\update-err.log"
    & npm install js-yaml@^4.1.1 --no-save --silent --no-audit --no-fund 2>>$errLog
    if ($LASTEXITCODE -eq 0) {
      Write-Host "   [ OK ] js-yaml 安裝完成"
    } else {
      Write-Host "   [ WARN ] js-yaml 安裝失敗 (詳見 $errLog)、big skill sync 仍會 fallback skip"
    }
  } finally {
    Pop-Location
  }
}

# v1.19.14：device-fingerprint 需要 node-machine-id
# 對應 update.sh 的 0b 區塊。idempotent：已裝就 skip。
$MachineIdDir = Join-Path $OwnMindDir "node_modules\node-machine-id"
if (-not (Test-Path $MachineIdDir)) {
  Write-Host "   📦 安裝錯誤回報工具用的依賴 node-machine-id..."
  Push-Location $OwnMindDir
  try {
    $errLog = Join-Path $env:USERPROFILE ".ownmind\logs\update-err.log"
    & npm install node-machine-id@^1.1.12 --no-save --silent --no-audit --no-fund 2>>$errLog
    if ($LASTEXITCODE -eq 0) {
      Write-Host "   [ OK ] node-machine-id 安裝完成"
    } else {
      Write-Host "   [ WARN ] node-machine-id 安裝失敗、ownmind_report_bug 會用 fallback 指紋"
    }
  } finally {
    Pop-Location
  }
}

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
  Write-Host "[ OK ] Skills synced (ownmind-memory + ownmind-upgrade)"
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
  Write-Host "[ OK ] Upgrade rules synced to detected AI tools"
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
  Write-Host "[ OK ] Hook scripts synced"
}

# --- 2b. usage scanner ---
$ScannerJs = Join-Path $OwnMindDir "hooks\ownmind-usage-scanner.js"
if (Test-Path $ScannerJs) { Write-Host "[ OK ] Usage scanner ready" }

# --- 3. Claude Code settings.json：注入 hooks ---
$ClaudeSettings = Join-Path $ClaudeDir "settings.json"
$NoSessionFlag = Join-Path $OwnMindDir ".no-session-hook"
if (Test-Path $ClaudeSettings) {
  # v1.17.81：單引號 heredoc — JS code 內所有 $var / $(...) 原樣保留，不被 PS 展開
  $nodeScript = @'
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { loadOrSkip } = require(path.join(os.homedir(), '.ownmind/scripts/install-helpers/load-settings-safe.cjs'));
    // v1.17.23: argv[0]=node, argv[1]=script path, argv[2]+=user args
    const settingsPath = process.argv[2];
    const noSessionHook = process.argv[3] === 'true';
    const s = loadOrSkip(settingsPath, {});
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
'@
  $tmpScript = Join-Path $env:TEMP "ownmind-update-settings.js"
  Set-Content -Path $tmpScript -Value $nodeScript -Encoding UTF8
  $noFlag = if (Test-Path $NoSessionFlag) { 'true' } else { 'false' }
  try {
    & node $tmpScript $ClaudeSettings $noFlag 2>>$ErrLog
  } catch {
    Report-Error -Kind "update_settings_inject_failed" -Detail "Claude settings hook 注入 node 腳本失敗：$_" -ContextFile $ErrLog
  }
  Remove-Item $tmpScript -ErrorAction SilentlyContinue
}

# --- 3.5 v1.18.3 補修：補裝 Stop reply-lint hook + PostToolUse banner hook ---
# 同 update.sh 修法：v1.17.71/96 的 install.sh 有跑、但 update.ps1 沒、
# 既有 user 升級時漏裝。Idempotent helper、多裝一次安全。
$AddStopHookHelper = Join-Path $OwnMindDir "scripts\install-helpers\add-stop-hook.cjs"
if ((Test-Path $AddStopHookHelper) -and (Test-Path $ClaudeSettings)) {
  $stopResult = & node $AddStopHookHelper $ClaudeSettings --ownmind-dir $OwnMindDir 2>&1
  Write-Host "   Stop reply-lint hook：$stopResult"
}
$AddPostHookHelper = Join-Path $OwnMindDir "scripts\install-helpers\add-post-tool-use-hook.cjs"
if ((Test-Path $AddPostHookHelper) -and (Test-Path $ClaudeSettings)) {
  $postResult = & node $AddPostHookHelper $ClaudeSettings --ownmind-dir $OwnMindDir 2>&1
  Write-Host "   PostToolUse banner hook：$postResult"
}

# --- 4. Gemini CLI hooks ---
$GeminiDir = Join-Path $HOME ".gemini"
if (Test-Path $GeminiDir) {
  $GeminiSettings = Join-Path $GeminiDir "settings.json"
  $geminiNodeScript = @'
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { loadOrSkip } = require(path.join(os.homedir(), '.ownmind/scripts/install-helpers/load-settings-safe.cjs'));
    const p = process.argv[2];
    const s = loadOrSkip(p, {});
    if (!s.hooks) s.hooks = {};
    if (!s.hooks.SessionStart) s.hooks.SessionStart = [];
    const exists = s.hooks.SessionStart.some(h =>
      (h.command || '').includes('ownmind') ||
      (h.hooks && h.hooks.some(hh => (hh.command || '').includes('ownmind')))
    );
    if (!exists) {
      s.hooks.SessionStart.push({ type: 'command', command: 'bash ~/.claude/hooks/ownmind-session-start.sh' });
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, p);
      console.log('   Gemini CLI SessionStart hook 已加入');
    }
'@
  $tmpGemini = Join-Path $env:TEMP "ownmind-update-gemini.js"
  Set-Content -Path $tmpGemini -Value $geminiNodeScript -Encoding UTF8
  & node $tmpGemini $GeminiSettings 2>>$ErrLog
  Remove-Item $tmpGemini -ErrorAction SilentlyContinue
}

# --- 5. GitHub Copilot hooks ---
$GithubDir = Join-Path $HOME ".github"
$GhCmd = Get-Command gh -ErrorAction SilentlyContinue
if ((Test-Path $GithubDir) -or $GhCmd) {
  $GhHookDir = Join-Path $GithubDir "hooks"
  $GhHookFile = Join-Path $GhHookDir "hooks.json"
  if (-not (Test-Path $GhHookDir)) { New-Item -ItemType Directory -Force -Path $GhHookDir | Out-Null }
  $copilotNodeScript = @'
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { loadOrSkip } = require(path.join(os.homedir(), '.ownmind/scripts/install-helpers/load-settings-safe.cjs'));
    const p = process.argv[2];
    const s = loadOrSkip(p, { version: 1, hooks: {} });
    if (!s.hooks) s.hooks = {};
    if (!s.hooks.sessionStart) s.hooks.sessionStart = [];
    const exists = s.hooks.sessionStart.some(h => (h.command || '').includes('ownmind'));
    if (!exists) {
      s.hooks.sessionStart.push({ command: 'bash ~/.claude/hooks/ownmind-session-start.sh' });
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, p);
      console.log('   GitHub Copilot sessionStart hook 已加入');
    }
'@
  $tmpGh = Join-Path $env:TEMP "ownmind-update-copilot.js"
  Set-Content -Path $tmpGh -Value $copilotNodeScript -Encoding UTF8
  & node $tmpGh $GhHookFile 2>>$ErrLog
  Remove-Item $tmpGh -ErrorAction SilentlyContinue
}

# --- 6. Cursor hooks ---
$CursorDir = Join-Path $HOME ".cursor"
if (Test-Path $CursorDir) {
  $CursorHooks = Join-Path $CursorDir "hooks.json"
  $cursorNodeScript = @'
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { loadOrSkip } = require(path.join(os.homedir(), '.ownmind/scripts/install-helpers/load-settings-safe.cjs'));
    const p = process.argv[2];
    const s = loadOrSkip(p, { version: 1, hooks: {} });
    if (!s.hooks) s.hooks = {};
    if (!s.hooks['session-start']) s.hooks['session-start'] = [];
    const exists = s.hooks['session-start'].some(h => (h.command || '').includes('ownmind'));
    if (!exists) {
      s.hooks['session-start'].push({ command: 'bash ~/.claude/hooks/ownmind-session-start.sh' });
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, p);
      console.log('   Cursor session-start hook 已加入');
    }
'@
  $tmpCursor = Join-Path $env:TEMP "ownmind-update-cursor.js"
  Set-Content -Path $tmpCursor -Value $cursorNodeScript -Encoding UTF8
  & node $tmpCursor $CursorHooks 2>>$ErrLog
  Remove-Item $tmpCursor -ErrorAction SilentlyContinue
}

# --- 標記已安裝 ---
$null = New-Item -ItemType File -Force -Path (Join-Path $OwnMindDir ".session-hook-installed")

Write-Host "─────────────────────────────────────────────"
Write-Host "OwnMind sync complete"
