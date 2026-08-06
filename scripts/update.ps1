# OwnMind 同步更新腳本（Windows PowerShell 版）— light sync only
#
# ⚠️ 這支只做 skill / hook / settings 同步，**不是完整升級流程**。
#    要升級 OwnMind 版本請改跑：
#       powershell -ExecutionPolicy Bypass -File ~/.ownmind/scripts/bootstrap.ps1
#    bootstrap 會自動判斷 install / upgrade / repair 並走對應流程。
#
# 適用場景：git pull 後 / install.ps1 尾端，把 ~/.ownmind/ 內檔同步到各工具目錄。
# v1.17.22 新增（修 Alice / Bob 卡舊版的根因）。
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

# --- 0. Root-level dependencies (mirrors section 0 of update.sh) ---
# v1.26.41: the guard used to be Test-Path on node_modules\<pkg>, so a package was
# never touched again once present and a later security patch could not reach anyone
# who had already installed. Gate on the installed version instead. Anything
# unreadable counts as "below the floor" and triggers a reinstall.
function Test-RootDepNeeded {
  param([string]$Package, [string]$MinVersion)
  $checker = Join-Path $OwnMindDir "scripts\install-helpers\dep-floor-cli.mjs"

  # Check the preconditions here rather than inferring them from an exit code.
  # This is the first native command the script runs, so $LASTEXITCODE does not
  # exist yet, and if node is absent `& node` throws CommandNotFoundException
  # without ever setting it -- reading it under the Set-StrictMode -Version Latest
  # above would then be an error rather than a value. Assigning $LASTEXITCODE
  # inside this function is not a fix either: it would create a local that shadows
  # the global the engine sets, and every later read would return the stale local.
  if (-not (Test-Path $checker)) { return $true }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $true }

  # `*> $null` and not `2> $null`: a PowerShell function returns everything left on
  # the pipeline, so any stray stdout from node would be returned alongside the
  # boolean and make the `if` see a non-empty array -- always truthy, reinstalling
  # every sync. dep-floor-cli.mjs is silent by contract; this keeps it true
  # regardless. `*>` is available in PowerShell 3.0 and up, which covers the
  # Windows PowerShell 5.1 that mcp/index.js invokes.
  & node $checker $OwnMindDir $Package $MinVersion *> $null
  return ($LASTEXITCODE -ne 0)
}

# v1.18.5: conditional-sync-cli.js needs js-yaml, otherwise the module fails to load
# and the SessionStart hook silently stops updating the big skill.
# Floor 4.3.0 — CVE-2026-59869, quadratic CPU via YAML merge-key chains.
if (Test-RootDepNeeded -Package "js-yaml" -MinVersion "4.3.0") {
  Write-Host "   📦 Installing / updating conditional-sync dependency: js-yaml..."
  Push-Location $OwnMindDir
  try {
    $errLog = Join-Path $env:USERPROFILE ".ownmind\logs\update-err.log"
    & npm install js-yaml@^4.3.0 --no-save --silent --no-audit --no-fund 2>>$errLog
    if ($LASTEXITCODE -eq 0) {
      Write-Host "   [ OK ] js-yaml ready"
    } else {
      Write-Host "   [ WARN ] js-yaml install failed (see $errLog); big skill sync will fall back to skip"
    }
  } finally {
    Pop-Location
  }
}

# v1.19.14: device-fingerprint needs node-machine-id for a stable "same machine"
# identifier.
if (Test-RootDepNeeded -Package "node-machine-id" -MinVersion "1.1.12") {
  Write-Host "   📦 Installing / updating bug-report-tool dependency: node-machine-id..."
  Push-Location $OwnMindDir
  try {
    $errLog = Join-Path $env:USERPROFILE ".ownmind\logs\update-err.log"
    & npm install node-machine-id@^1.1.12 --no-save --silent --no-audit --no-fund 2>>$errLog
    if ($LASTEXITCODE -eq 0) {
      Write-Host "   [ OK ] node-machine-id ready"
    } else {
      Write-Host "   [ WARN ] node-machine-id install failed; ownmind_report_bug will use a fallback fingerprint"
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
  # v1.26.80 — 只同步 *.sh 的話，Windows 使用者手上的 node 版掛勾永遠停在安裝那天。
  # 跟排程那個缺陷同一個形狀：安裝時是對的，之後沒有任何地方維護它。
  # 逐一指名而不是抓 *.js —— hooks\ 底下其他 .js 是給 ~/.ownmind 執行的，不屬於這裡。
  foreach ($nodeHook in @("ownmind-session-start.js", "ownmind-iron-rule-check.js")) {
    $nodeHookSrc = Join-Path $OwnMindDir "hooks\$nodeHook"
    if (Test-Path $nodeHookSrc) { Copy-Item -Force -Path $nodeHookSrc -Destination $HookDir }
  }
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

# --- 2c. Repair the scanner's scheduled task if it has died (v1.26.79) ---
# Having a current scanner on disk says nothing about whether anything still runs it.
# Adam's machine had both the files and the auto-update working, and no scheduled task,
# for three weeks.
#
# The exit code is deliberately not propagated. The sync itself succeeded, and failing the
# whole run would make mcp/index.js log update_failed and retry. The failure is not
# swallowed either: ensure-scanner-schedule.ps1 sends a Report-Error, so it shows up on
# the server rather than only in a console window that nobody sees.
# --- 2d. 讓機器自己回報健康狀況（v1.26.81）---
# 完整的自我檢查以前只在安裝跟手動升級時跑。Adam 上一次完整回報是 2026-05-29，之後兩個月
# 每天自動更新、什麼都沒說，而他的掃描器早就死了。而且他五月那份回報裡就已經有答案
# （bash_resolution.selected = WSL_RELAY），只是沒有人看。
#
# --quick 拿掉唯一會掃描所有本機資料庫的那一項。背景執行、不擋更新。
$SelfCheck = Join-Path $OwnMindDir "scripts\install-helpers\self-check.cjs"
if (Test-Path $SelfCheck) {
  try {
    Start-Process -FilePath "node" `
      -ArgumentList @($SelfCheck, "--trigger=auto_update", "--quick") `
      -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
  } catch { }
}

$EnsureSchedule = Join-Path $OwnMindDir "scripts\install-helpers\ensure-scanner-schedule.ps1"
if (Test-Path $EnsureSchedule) {
  $scheduleResult = & powershell -NoProfile -ExecutionPolicy Bypass -File $EnsureSchedule 2>&1
  Write-Host "   Usage scanner schedule: $scheduleResult"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "   [ WARN ] scanner schedule is not running and could not be repaired; reported to server"
  }
}

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

    // v1.26.80: this used to hardcode 'bash ~/.claude/hooks/ownmind-session-start.sh'.
    // install.ps1 writes the Node command on Windows; this block recognised that entry,
    // saw it lacked the four matchers, deleted it, and wrote bash back. Every Windows
    // machine runs an update daily, so the correct command survived until the first one,
    // and the hook then never fired again — 0 loads across 6 machines in 90 days.
    //
    // Wrapped: on the update that *delivers* this helper, an uncaught MODULE_NOT_FOUND
    // would kill this node script and skip every hook below it.
    let hookCmd = null;
    try {
      hookCmd = require(path.join(os.homedir(), '.ownmind/scripts/install-helpers/session-hook-command.cjs'));
    } catch { hookCmd = null; }

    if (!noSessionHook && hookCmd) {
      if (!s.hooks.SessionStart) s.hooks.SessionStart = [];
      const newEntries = hookCmd.sessionStartEntries({
        platform: process.platform,
        ownmindDir: path.join(os.homedir(), '.ownmind'),
      });
      const isOwnmindEntry = hookCmd.isOwnmindSessionEntry;
      const existing = s.hooks.SessionStart.filter(isOwnmindEntry);
      // Matchers complete is not the same question as command correct. Every Windows
      // machine today has all four matchers, all running bash; judging by matchers alone
      // would call them healthy and repair nobody.
      if (hookCmd.needsRewrite(existing, { platform: process.platform, ownmindDir: path.join(os.homedir(), '.ownmind') })) {
        s.hooks.SessionStart = s.hooks.SessionStart.filter(h => !isOwnmindEntry(h));
        s.hooks.SessionStart.push(...newEntries);
        changed = true;
      } else if (existing.length === 0 && s.hooks.SessionStart.length === 0) {
        s.hooks.SessionStart.push(...newEntries);
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
