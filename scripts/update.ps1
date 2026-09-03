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
    $cfg = Get-Content $claudeSettings -Raw -Encoding UTF8 | ConvertFrom-Json
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
# Floor 4.3.1 — CVE-2026-59869 (quadratic CPU via YAML merge-key chains) plus the
# 4.3.1 backport of the same shape in `!!omap` duplicate-key detection. Keep this in
# step with package.json and with update.sh; dep-floor-guard turns red otherwise.
if (Test-RootDepNeeded -Package "js-yaml" -MinVersion "4.3.1") {
  Write-Host "   📦 Installing / updating conditional-sync dependency: js-yaml..."
  Push-Location $OwnMindDir
  try {
    $errLog = Join-Path $env:USERPROFILE ".ownmind\logs\update-err.log"
    & npm install js-yaml@^4.3.1 --no-save --silent --no-audit --no-fund 2>>$errLog
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
$AppendRuleHelper = Join-Path $OwnMindDir "scripts\windows\lib\append-upgrade-rule.ps1"
if ((Test-Path $UpgradeSnippet) -and -not (Test-Path $AppendRuleHelper)) {
  # Ships in the same commit as this file, so its absence means an incomplete checkout —
  # worth a line, because the alternative is skipping the whole step in silence.
  Write-Host "[WARN] Upgrade rules skipped: helper missing at $AppendRuleHelper"
}
if ((Test-Path $UpgradeSnippet) -and (Test-Path $AppendRuleHelper)) {
  . $AppendRuleHelper
  # ReadAllText, not Get-Content -Raw: the snippet is UTF-8 with Chinese in it and carries no
  # BOM, and Windows PowerShell 5.1 reads a BOM-less file in the system ANSI code page. Every
  # Traditional Chinese Windows machine has been writing a mangled copy of this rule into
  # every AI tool it found.
  $rawSnippet = [System.IO.File]::ReadAllText($UpgradeSnippet)
  if ($null -eq $rawSnippet) { $rawSnippet = '' }

  $targets = @(
    (Join-Path $HOME ".codex\AGENTS.md"),
    (Join-Path $HOME ".cursor\rules\ownmind.md"),
    (Join-Path $HOME ".antigravity\rules\ownmind.md"),
    (Join-Path $HOME ".opencode\AGENTS.md"),
    (Join-Path $HOME ".windsurf\rules\ownmind.md"),
    (Join-Path $HOME ".gemini\GEMINI.md")
  )

  # Counted rather than assumed. The previous version printed a fixed "[ OK ]" line whatever
  # happened, so a tool that threw on the way past looked exactly like one that synced.
  $written = 0
  $failed = @()
  foreach ($target in $targets) {
    try {
      if ((Add-OwnMindUpgradeRule -TargetFile $target -Snippet $rawSnippet) -eq 'written') {
        $written += 1
      }
    } catch {
      $failed += "$target ($($_.Exception.Message))"
    }
  }

  if ($failed.Count -gt 0) {
    Write-Host "[WARN] Upgrade rules synced to $written AI tool(s); $($failed.Count) failed:"
    foreach ($f in $failed) { Write-Host "       - $f" }
  } else {
    Write-Host "[ OK ] Upgrade rules synced to $written detected AI tool(s)"
  }
}

# --- 1c. 同步 OwnMind 規則區塊到每個 AI 工具的指示檔 ---
#
# v1.26.141. 用的是 update.sh 同一支 node 腳本，不是另寫一份 PowerShell 版：
# 標記區塊這件事本來就寫過兩份，而 v1.26.140 抓到 PowerShell 那份對空檔案會炸、
# shell 那份不會 —— 三個作業系統都要一樣的東西，就該只有一份實作。
$RulesBlock = Join-Path $OwnMindDir "configs\ownmind-rules-block.md"
$RulesSync = Join-Path $OwnMindDir "scripts\install-helpers\sync-rules-block.cjs"
# The node guard this file's own comment at Test-RootDepNeeded explains: `& node` with node
# absent throws CommandNotFoundException, and reading $LASTEXITCODE when no native command
# has run is an error under Set-StrictMode -Version Latest.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[WARN] node not found; OwnMind rules block not written"
} elseif ((Test-Path $RulesBlock) -and (Test-Path $RulesSync)) {
  $blockWritten = 0
  $blockFailed = @()
  $blockLegacy = $null

  function Sync-OwnMindRulesBlock {
    param([string]$TargetFile, [switch]$LegacyClaude)
    # NOT $args: that is an automatic variable in PowerShell, and assigning to it inside a
    # function is the kind of thing that works until it doesn't.
    $nodeArgs = @($RulesSync, '--target', $TargetFile, '--marker', 'ownmind-rules',
      '--snippet', $RulesBlock)
    if ($LegacyClaude) { $nodeArgs += '--legacy-claude' }
    $errLog = Join-Path $HOME ".ownmind\logs\update-err.log"
    $out = & node @nodeArgs 2>> $errLog
    if ($LASTEXITCODE -ne 0) { return 'failed' }
    # `repaired:` is a successful write that also removed a broken marker; without this it
    # fell through to 'failed' and a working upgrade printed a warning.
    if ($out -match '^written:' -or $out -match '^repaired:') { return 'written' }
    if ($out -match '^legacy-kept:') { return 'legacy-kept' }
    if ($out -match '^skipped:') { return 'skipped' }
    return 'failed'
  }

  $claudeMd = Join-Path $HOME ".claude\CLAUDE.md"
  switch (Sync-OwnMindRulesBlock -TargetFile $claudeMd -LegacyClaude) {
    'written'     { $blockWritten += 1 }
    'legacy-kept' { $blockWritten += 1; $blockLegacy = $claudeMd }
    'failed'      { $blockFailed += $claudeMd }
  }

  foreach ($blockTarget in @(
    (Join-Path $HOME ".codex\AGENTS.md"),
    (Join-Path $HOME ".cursor\rules\ownmind.md"),
    (Join-Path $HOME ".antigravity\rules\ownmind.md"),
    (Join-Path $HOME ".opencode\AGENTS.md"),
    (Join-Path $HOME ".windsurf\rules\ownmind.md"),
    (Join-Path $HOME ".gemini\GEMINI.md")
  )) {
    switch (Sync-OwnMindRulesBlock -TargetFile $blockTarget) {
      'written'     { $blockWritten += 1 }
      'legacy-kept' { $blockWritten += 1 }
      'failed'      { $blockFailed += $blockTarget }
    }
  }

  if ($blockFailed.Count -gt 0) {
    Write-Host "[WARN] OwnMind rules written to $blockWritten file(s); $($blockFailed.Count) failed:"
    foreach ($f in $blockFailed) { Write-Host "       - $f" }
    Write-Host "       see $HOME\.ownmind\logs\update-err.log"
  } else {
    Write-Host "[ OK ] OwnMind rules written to $blockWritten AI instruction file(s)"
  }
  if ($blockLegacy) {
    Write-Host "[NOTE] $blockLegacy still has an older OwnMind section that you edited by hand."
    Write-Host "       It was left alone. Delete the '# OwnMind 個人記憶系統' section when convenient."
  }
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
  # gate-message-i18n task 7 — same reasoning as hooks\lib above: hooks\locales holds the
  # gate/lint/compliance message dictionaries hooks\lib\i18n.js reads at runtime, and this
  # is the only path a Windows machine's fallback copy ever gets refreshed through.
  # The dot-name filter keeps this twin of install.sh's `cp hooks/locales/*.json` honest: a
  # POSIX shell glob never matches a leading dot, but PowerShell's "*.json" does, so without
  # it hooks\locales\.translate-cache.json — a gitignored build artifact of the translate
  # pipeline, not a dictionary — lands in ~\.claude\hooks\locales on Windows only.
  $HookLocalesDir = Join-Path $HookDir "locales"
  $LocalesSrc = Join-Path $OwnMindDir "hooks\locales"
  if (Test-Path $LocalesSrc) {
    New-Item -ItemType Directory -Force -Path $HookLocalesDir | Out-Null
    Get-ChildItem -Path $LocalesSrc -Filter "*.json" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notlike ".*" } |
      ForEach-Object { Copy-Item -Force -Path $_.FullName -Destination $HookLocalesDir }
  }
  Write-Host "[ OK ] Hook scripts synced"
}

# --- 2a2. Reinstall the git hook wrappers (v1.26.104) ---
#
# Same defect as the *.js sync above, one directory over, and this script never touched
# these at all. The auto-update path is `git pull` → `npm install` → this script, never
# install.ps1. `~/.ownmind` IS the checkout, so a pull replaces the hook logic under
# `hooks/` immediately, while `git-hooks/` keeps whatever install.ps1 copied on the day it
# last ran. When a release moves work from one wrapper to another, the user ends up with
# the new half and not the old one, and nothing reports it.
$GitHookDir = Join-Path $HOME ".ownmind\git-hooks"
if (Test-Path $GitHookDir) {
  $refreshed = 0
  foreach ($ghName in @("pre-commit", "post-commit", "commit-msg", "pre-merge-commit")) {
    $ghDest = Join-Path $GitHookDir $ghName
    $ghSrc = Join-Path $OwnMindDir "hooks\ownmind-git-$ghName"
    # Only refresh a hook that is already installed — creating one here would switch on
    # OwnMind's git hooks for somebody who never asked install.ps1 for them.
    #
    # pre-merge-commit is the one exception, and it does not weaken that: it shipped after
    # these wrappers did, so every existing install has pre-commit and none has this one.
    # "Refresh only" would leave every machine already using OwnMind's git hooks with its
    # merges unchecked forever (bug report #24, and the v1.26.104 trap). It is created only
    # where pre-commit is already present, so the consent question is unchanged — this
    # machine's owner did ask for OwnMind's git hooks.
    if (-not (Test-Path $ghDest)) {
      if ($ghName -ne "pre-merge-commit") { continue }
      if (-not (Test-Path (Join-Path $GitHookDir "pre-commit"))) { continue }
    }
    if (-not (Test-Path $ghSrc)) { continue }
    # LF, always: these run under sh.exe, and CRLF makes the shebang line unusable.
    $srcText = [System.IO.File]::ReadAllText($ghSrc).Replace("`r`n", "`n")
    # Absent on the pre-merge-commit create path above, and ReadAllText on a missing file
    # throws — which under this script's ErrorActionPreference would print a red error on
    # every Windows update, or worse, stop the rest of the file from running.
    $destText = if (Test-Path $ghDest) { [System.IO.File]::ReadAllText($ghDest) } else { $null }
    if ($srcText -ne $destText) {
      [System.IO.File]::WriteAllText($ghDest, $srcText)
      $refreshed++
    }
  }
  if ($refreshed -gt 0) { Write-Host "[ OK ] Refreshed $refreshed git hook wrapper(s)" }
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
$EnsureSchedule = Join-Path $OwnMindDir "scripts\install-helpers\ensure-scanner-schedule.ps1"
if (Test-Path $EnsureSchedule) {
  $scheduleResult = & powershell -NoProfile -ExecutionPolicy Bypass -File $EnsureSchedule 2>&1
  Write-Host "   Usage scanner schedule: $scheduleResult"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "   [ WARN ] scanner schedule is not running and could not be repaired; reported to server"
  }
}

# --- 3.0b Ensure the MCP server is registered where Claude Code launches it (v1.26.112) ---
#
# Has to live in the updater, not only in install.ps1. Nobody re-runs the installer: the
# auto-update path is git pull -> npm install -> update.ps1, so an install-only fix reaches
# new users and nobody else. That is the trap v1.26.104 fell into with the git-hook
# wrappers, and it would be worse here, because the release notes would claim the repair
# while every installed machine stayed exactly as broken.
#
# Every existing machine has mcpServers.ownmind in ~/.claude/settings.json and nothing in
# ~/.claude.json, which is the file Claude Code actually launches MCP servers from.
$RegisterMcp = Join-Path $OwnmindDir "scripts/install-helpers/register-mcp-cli.cjs"
if (Test-Path $RegisterMcp) {
  # A real file plus argv - see the note in install.ps1: `node -e` does not survive
  # PowerShell 5.1 argument passing.
  $RegisterCli = Join-Path $OwnmindDir "scripts/install-helpers/register-mcp-cli.cjs"
  $regOut = & node $RegisterCli --upgrade $HOME 2>>$ErrLog
  if ($regOut -contains "REGISTERED") {
    Write-Host "   MCP 已註冊到 ~/.claude.json（Claude Code 從這裡啟動它，重開 session 後生效）"
  } elseif ($regOut -contains "FAILED") {
    Write-Host "   [WARN] MCP 無法註冊到 ~/.claude.json，ownmind_* 工具在 Claude Code 裡不會出現"
  }
}

# --- 3. 移除舊版註冊的 WorktreeCreate hook ---
# SessionStart 在 3.4、PreToolUse 在 3.3b，各自有共用實作。這裡原本還註冊了一個
# WorktreeCreate hook，那個 hook 會讓這台機器上每個 repo 的 EnterWorktree 一律失敗；
# 會踩到的人全都是已經裝好的人，所以移除要跑在升級這條路上，理由見 remove-worktree-hook.cjs。
$ClaudeSettings = Join-Path $ClaudeDir "settings.json"
$RemoveWorktreeHook = Join-Path $OwnMindDir "scripts\install-helpers\remove-worktree-hook.cjs"
if ((Test-Path $ClaudeSettings) -and (Test-Path $RemoveWorktreeHook)) {
  try {
    $worktreeOut = & node $RemoveWorktreeHook $ClaudeSettings 2>>$ErrLog
    if ($worktreeOut) { Write-Host "   $worktreeOut" }
  } catch {
    Report-Error -Kind "update_worktree_hook_removal_failed" -Detail "移除 WorktreeCreate hook 失敗：$_" -ContextFile $ErrLog
  }
}
Remove-Item (Join-Path $ClaudeDir "hooks\ownmind-worktree-setup.sh") -ErrorAction SilentlyContinue

# --- 3.3b PreToolUse iron-rule hooks (v1.26.105, delegated to the shared implementation) ---
# No --bash: Windows always runs the node hook out of the checkout (see install.ps1's v1.26.80
# note — System32\bash.exe is a WSL launcher, and ~ inside it is not this machine's home).
$EnsurePreHook = Join-Path $OwnMindDir "scripts\install-helpers\ensure-pretooluse-hooks.cjs"
if (Test-Path $EnsurePreHook) {
  $preHookResult = & node $EnsurePreHook $ClaudeSettings --ownmind-dir $OwnMindDir 2>&1
  Write-Host "   PreToolUse iron-rule hook: $preHookResult"
}

# --- 3.4 SessionStart hook (v1.26.86, delegated to the shared implementation) ---
$EnsureHook = Join-Path $OwnMindDir "scripts\install-helpers\ensure-session-hook.cjs"
if (Test-Path $EnsureHook) {
  $hookResult = & node $EnsureHook --ownmind-dir $OwnMindDir 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host "   SessionStart hook: $hookResult"
  } else {
    Write-Host "   [FAIL] SessionStart hook: $hookResult"
  }
}

# --- 3.4b Background credentials (v1.26.87, delegated to the shared implementation) ---
# The key can be valid, the MCP can be uploading, and every scheduled run can still be
# blind — Task Scheduler does not inherit a shell's environment.
$EnsureKeyFile = Join-Path $OwnMindDir "scripts\install-helpers\ensure-key-file.cjs"
if (Test-Path $EnsureKeyFile) {
  $keyResult = & node $EnsureKeyFile --ownmind-dir $OwnMindDir 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host "   Background credentials: $keyResult"
  } else {
    Write-Host "   [FAIL] Background credentials: $keyResult"
  }
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

# --- 7. Have the machine report its own health (v1.26.81, moved to the tail in v1.26.105) ---
# The full self-check used to run only during install and manual upgrade. Adam's last
# complete report is dated 2026-05-29; his machine auto-updated daily for two months
# afterwards and said nothing, while his scanner was already dead — and the May report he
# did send already held the answer (bash_resolution.selected = WSL_RELAY).
#
# It runs LAST, after every repair above. It used to sit in section 2d, ahead of all of
# them, so it reported the state this script was about to fix: one alert per machine, about
# a machine that is healthy by the time anybody reads it. install.ps1 has always run its
# artifact check at the tail for exactly this reason.
#
# --quick drops the one check that scans every local database. Fire-and-forget, in the
# background, never blocking the update.
$SelfCheck = Join-Path $OwnMindDir "scripts\install-helpers\self-check.cjs"
if (Test-Path $SelfCheck) {
  try {
    Start-Process -FilePath "node" `
      -ArgumentList @($SelfCheck, "--trigger=auto_update", "--quick") `
      -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
  } catch { }
}

# --- 標記已安裝 ---
$null = New-Item -ItemType File -Force -Path (Join-Path $OwnMindDir ".session-hook-installed")

Write-Host "─────────────────────────────────────────────"
Write-Host "OwnMind sync complete"
