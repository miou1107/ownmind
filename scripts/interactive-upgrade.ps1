# OwnMind 互動式升級 script — Windows PowerShell (v1.17.0 P5, v1.17.66 hardened)
#
# 用法：powershell -ExecutionPolicy Bypass -File ~/.ownmind/scripts/interactive-upgrade.ps1
# stdout 格式與 bash 版相同（INFO / OK / ERROR / ASK 前綴）
#
# v1.17.66 變更（Alice / Bob Windows 升級失敗劇本）：
#   1. 三處 bash 改走 Find-GitBash helper（避開 System32\bash.exe WSL relay）
#   2. 所有 Out-File / 重導向加 -Encoding utf8（避免 UTF-16 BOM 中文 garbled）
#   3. 流程包進 try/finally，self-check.cjs 觀測在 finally 區塊保證執行（IR-038）
#   4. verify_local 失敗不再連帶 Rollback — verify 是事後體檢，不擋升級

Set-StrictMode -Version Latest
Set-ExecutionPolicy -Scope Process Bypass -Force -ErrorAction SilentlyContinue

# 環境正規化（v1.17.9, 回報者 Bob）— Git Bash / MSYS 會把 $HOME 污染成 /c/Users/xxx
if ($env:USERPROFILE -and ($HOME -ne $env:USERPROFILE)) {
  Set-Variable -Name HOME -Value $env:USERPROFILE -Force -Scope Global -ErrorAction SilentlyContinue
}

$OwnMindDir = Join-Path $HOME ".ownmind"
$Ts = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDir = Join-Path $HOME ".ownmind.bak.$Ts"
# v1.26.98 — the log lives OUTSIDE $OwnMindDir, matching interactive-upgrade.sh (bug #15).
# Rollback is `Remove-Item -Recurse -Force $OwnMindDir` followed by `Move-Item`, so while this
# file lived under $OwnMindDir\logs\ every failure message that said "see $LogFile" named a
# file the same function had just deleted. The .sh side moved in v1.26.88; the Windows side
# was left behind, which is why the Windows half of the team still had no readable log.
$LogDir = Join-Path $HOME ".ownmind-logs"
try { New-Item -ItemType Directory -Force -Path $LogDir -ErrorAction Stop | Out-Null }
catch { $LogDir = [System.IO.Path]::GetTempPath() }
# v1.26.98 — $OwnMindDir\logs is no longer where this script logs, but the upgrade-complete
# beacon still spools into it, and [System.IO.File]::AppendAllText throws rather than creating
# a missing parent. Moving $LogDir out took the `New-Item` that used to make it, so the spool
# would have started failing silently. The .sh side keeps its own `mkdir -p` for the same
# reason (IR-022).
try { New-Item -ItemType Directory -Force -Path (Join-Path $OwnMindDir "logs") -ErrorAction Stop | Out-Null } catch { }
$LogFile = Join-Path $LogDir "upgrade-$Ts.log"

function Step($code, $msg) { Write-Host "INFO:${code}:$msg" }
function OK($code, $msg)   { Write-Host "OK:${code}:$msg" }
# v1.17.66 review fix — Fail 改成 throw（不直接 exit）。
# 為什麼：PowerShell 5.1/7.x 在 try block 內遇到 `exit` 時，finally 不一定會跑
# （MS docs 說會跑，但實測有 bug 報告）。改成 throw + 外層 catch + finally
# 確保 self-check 觀測一定執行（IR-038）。
# v1.17.85 IR-038：throw 前統一補 fallback Report-Error，避免漏網的 Fail path
# 沒留觀測資料（對應 .sh 的 FAIL 修法、保持兩端對稱 IR-022）。kind 帶
# _terminal 後綴讓 admin 區別「終點觀測」vs caller 先 call 的「_step 級觀測」。
function Fail($code, $msg) {
  try {
    if (Get-Command Report-Error -ErrorAction SilentlyContinue) {
      Report-Error -Kind "upgrade_failed_terminal_$code" -Detail "${msg}: $(Get-LastLogLines $LogFile)" -ContextFile $LogFile
    }
  } catch { }
  throw "ERROR:${code}:$msg"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# v1.17.79 — 載入 report-error helper（IR-038）
$reportErrorHelper = Join-Path $OwnMindDir 'scripts\install-helpers\report-error.ps1'
if (Test-Path $reportErrorHelper) {
  . $reportErrorHelper
} else {
  function Report-Error { param($Kind, $Detail, $ContextFile = "") }
}

# v1.17.84 — Windows file-lock detection（vin-windows-test 第七輪）
# OwnMind MCP node process 持有 ~/.ownmind/mcp/node_modules/*.js handle 時，
# git pull / npm install 會吃 EBUSY / EACCES。掃 log 找 lock pattern，中了就改錯誤碼為
# file_locked 並給明確提示。
# v1.26.98 — 'it is in use' added. PowerShell's own wording when Remove-Item cannot delete a
# locked directory is "Cannot remove the item at '...' because it is in use.", which matched
# none of the previous patterns. Measured on TANK, 2026-08-07.
$script:FileLockPattern = 'EBUSY|EACCES|EPERM|Permission denied|in use by another|another process|file is locked|resource busy|access is denied|it is in use|being used by another'

# v1.26.98 — what the failing command actually said, folded onto one line for Detail.
#
# Every Report-Error call below passed a hand-written guess ("git pull --ff-only failed
# (network or non-ff merge)"), and that guess is the same sentence whether the remote was
# unreachable, the branch had diverged, or a file was locked. On 2026-08-07 DESKTOP-8DD75VJ
# failed a pull and nobody could say why, because the guess was the only record of it.
#
# The log file is already passed as ContextFile, but that report arrived with an empty
# context and we have no way to reproduce the Windows path from here. Detail is a plain
# string that is known to arrive, so the reason goes there too. Mirrors last_log_lines in
# interactive-upgrade.sh, including the 300-character cap.
$script:ReasonMaxChars = 300
function Get-LastLogLines {
  param([string]$LogPath = "")
  if (-not $LogPath -or -not (Test-Path $LogPath)) { return "no log file" }
  try {
    $lines = Get-Content $LogPath -Tail 5 -ErrorAction Stop
  } catch { return "log unreadable" }
  if (-not $lines) { return "log empty" }
  # Control characters stripped: a newline here produces a line that is not valid JSON and
  # the whole report is dropped on arrival.
  $text = ($lines -join "|") -replace '[\x00-\x1f]', ' '
  if ($text.Length -gt $script:ReasonMaxChars) { $text = $text.Substring(0, $script:ReasonMaxChars) }
  return $text
}

function Test-FileLockError {
  param([string]$LogPath)
  if (-not (Test-Path $LogPath)) { return $false }
  return $null -ne (Select-String -Path $LogPath -Pattern $script:FileLockPattern -CaseSensitive:$false -Quiet)
}

# Same test against an in-memory string (an exception message), not a file on disk.
# v1.26.98 — collapse a captured command's output to a single capped line.
#
# `git pull 2>&1` does not give strings: PowerShell wraps native stderr in ErrorRecord
# objects, and `Out-String` renders those across several lines. That text then goes into
# `Write-Host "ERROR:<code>:<message>"`, and the caller reading this script parses one line
# at a time — so a multi-line message silently breaks the contract the header documents.
# ForEach-Object ToString takes the message itself rather than the formatted record.
function ConvertTo-OneLine {
  param($InputObject)
  if ($null -eq $InputObject) { return "no detail captured" }
  $text = (@($InputObject) | ForEach-Object { $_.ToString() }) -join "|"
  $text = ($text -replace '[\x00-\x1f]', ' ').Trim()
  if ([string]::IsNullOrWhiteSpace($text)) { return "no detail captured" }
  if ($text.Length -gt $script:ReasonMaxChars) { $text = $text.Substring(0, $script:ReasonMaxChars) }
  return $text
}

function Test-FileLockErrorText {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return $false }
  return $Text -imatch $script:FileLockPattern
}

# --- v1.17.66 Self-check 觀測管道保證執行（IR-038） ---
# 用 try { 主流程 } catch { 印錯記 exit code } finally { 跑 self-check }
# 確保升級任何階段失敗，server 都能收到當下狀態 + 7 項本機 check + env。
$script:selfCheckRan = $false
$script:exitCode = 0
function Run-SelfCheckOnce {
  if ($script:selfCheckRan) { return }
  $script:selfCheckRan = $true
  $selfCheckScript = Join-Path $OwnMindDir 'scripts\install-helpers\self-check.cjs'
  if (Test-Path $selfCheckScript) {
    try { & node $selfCheckScript --trigger=post_upgrade } catch { }
  }
}

try {

# --- 0. Pre-check ---
Step "check" "Checking OwnMind directory"
if (-not (Test-Path $OwnMindDir)) { Fail "no_ownmind" "$OwnMindDir not found; run install.ps1 for fresh install" }
if (-not (Test-Path (Join-Path $OwnMindDir ".git"))) { Fail "no_git" "$OwnMindDir is not a git repo" }

# --- 1. Backup ---
Step "backup" "Backing up to $BackupDir"
try { Copy-Item -Recurse -Path $OwnMindDir -Destination $BackupDir; OK "backup" "Backup complete" }
catch { Fail "backup_failed" "Backup failed: $_" }

# v1.26.98 — Rollback used to swallow its own failure: the catch printed one line and
# execution continued, with no flag and no report. Every caller then emitted a hard-coded
# "backup restored", so the user was told the machine had been restored when it had not.
# Fail() forwards that same string to the server as the Detail of upgrade_failed_terminal_*,
# which means the diagnostic record admins read was asserting a restore that never happened.
#
# On Windows this is the common case, not an exotic one: Remove-Item cannot delete
# $OwnMindDir while the MCP node process (or Claude Code itself) holds a handle under
# mcp\node_modules — precisely the condition Test-FileLockError was written for, which had
# never been wired into this path. Observed on TANK, 2026-08-07:
#   ERROR:rollback_failed:Cannot remove the item at 'C:\Users\Vin\.ownmind' because it is in use.
#   ERROR:git_pull:git pull failed; backup restored
#
# Rollback now records what actually happened; RollbackNote renders it for the caller.
$script:RollbackFailed = $false

# v1.26.98 — keep a copy of the error reporter outside $OwnMindDir and point the helper at it.
# Rollback deletes that directory; if the move then fails, the reporter it would use has just
# been deleted too, and Report-Error returns having written nothing. See report-error.ps1.
$reportHelperSrc = Join-Path $OwnMindDir "scripts\install-helpers\report-error.cjs"
if (Test-Path $reportHelperSrc) {
  try {
    Copy-Item -Path $reportHelperSrc -Destination (Join-Path $LogDir "report-error.cjs") -Force -ErrorAction Stop
    $env:OWNMIND_REPORT_HELPER = Join-Path $LogDir "report-error.cjs"
  } catch { }
}

function Rollback {
  Step "rollback" "Restoring backup $BackupDir -> $OwnMindDir"
  $script:RollbackFailed = $false
  try {
    Remove-Item -Recurse -Force $OwnMindDir -ErrorAction Stop
    Move-Item -Path $BackupDir -Destination $OwnMindDir -ErrorAction Stop
    OK "rollback" "Restored previous version"
  } catch {
    $script:RollbackFailed = $true
    $detail = ConvertTo-OneLine $_
    $kind = if (Test-FileLockErrorText $detail) { "rollback_file_locked" } else { "rollback_failed" }
    Write-Host "ERROR:${kind}:$detail"
    try { Report-Error -Kind "upgrade_$kind" -Detail "Rollback failed: $detail" -ContextFile $LogFile } catch { }
  }
}

# The tail every rollback caller appends to its failure message, so the message describes the
# machine's real state instead of the state the rollback was supposed to produce.
function RollbackNote {
  if ($script:RollbackFailed) {
    return "ROLLBACK ALSO FAILED - $OwnMindDir may be half-updated and the backup is still at $BackupDir. Close Claude Code completely, then restore it manually"
  }
  return "backup restored"
}

# --- 2. git pull ---
# v1.17.79：先偵測 dirty working tree（user 的 AI 助手手動編輯 OwnMind 內檔很常見），
# dirty 就 Report-Error + git fetch + reset --hard origin/main 強制對齊（backup 保險絲已先做）。
# 真實案例：vin-windows-test 的 AI 編輯 mcp/start.cmd 加 fallback，下次 git pull --ff-only
# 直接被 reject、整個升級卡住，server 完全沒紀錄。
Step "pull" "Pulling latest OwnMind"
Push-Location $OwnMindDir

# v1.26.98 — the `2>$null` here turned a broken git into a silent "clean tree" (IR-002).
# `git status --porcelain` prints nothing when the tree is clean AND prints nothing when git
# itself dies, so an empty $dirty was ambiguous — and the ambiguity always resolved the unsafe
# way, straight into `git pull --ff-only` on a tree whose state was never established.
# The exit code is the only thing that separates the two cases, so check it.
# Prompted by a real observation on a Windows 10 box (git 2.54.0.windows.1) where
# `git status --porcelain` exited -1073741674 (0xC0000096) with no output on stdout or stderr,
# in a fresh empty repo as well as in ~/.ownmind, while add / diff / log / push all worked.
# The root cause was not established and is not the point: whatever makes git fail, an empty
# string must not be read as a verdict about the working tree.
# stderr is deliberately left alone rather than merged into $dirty: git emits CRLF warnings
# there, and folding those into the value would make a clean tree look dirty and trigger an
# unnecessary reset --hard.
#
# v1.26.144 — `--untracked-files=no`. The branch below answers a dirty tree with
# `git reset --hard`, and reset acts on tracked files only: an untracked path is still
# there when it finishes, so it chooses the destructive branch again on the next upgrade,
# and the one after that. One member's machine has reported `tree: ?? standards/` on every
# upgrade for exactly this reason. `bin/` and `reports/` are ours and are now ignored, so
# they leave status entirely; a path like `standards/` is neither, and the listing below
# keeps it visible in the log. Neither overwrites anything any more.
$statusErr = "$LogFile.status"
$dirty = git status --porcelain --untracked-files=no 2>$statusErr
$statusCode = $LASTEXITCODE
if (Test-Path $statusErr) { Get-Content $statusErr -ErrorAction SilentlyContinue | Out-File -Append $LogFile -Encoding utf8 }
if ($statusCode -ne 0) {
  # Reporting only the exit code repeats the mistake this release is about; keep what git said.
  $statusSaid = ConvertTo-OneLine (Get-Content $statusErr -ErrorAction SilentlyContinue)
  Report-Error -Kind "upgrade_git_status_failed" -Detail "git status --porcelain exited ${statusCode}: $statusSaid" -ContextFile $statusErr
  Pop-Location
  # No Rollback: nothing has been modified yet, so restoring would only risk the file-lock
  # failure above for no gain. The backup copy stays put for sweep-old-backups to retire.
  Fail "git_status" "git status failed (exit $statusCode); the working tree state could not be established, so the upgrade stopped before changing anything. Check the local git installation, then re-run."
}
# Recorded, not acted on. Whoever reads an upgrade log still gets to see what else is in
# the directory; the decision above is not theirs to make.
# -match, not -like: in -like a `?` is a single-character wildcard, so '??*' would match
# every status line rather than the untracked ones.
$untracked = git status --porcelain --untracked-files=normal 2>$null | Where-Object { $_ -match '^\?\?' }
if ($untracked) {
  "[info] untracked paths present (not touched by this upgrade):" | Out-File -Append $LogFile -Encoding utf8
  $untracked | Out-File -Append $LogFile -Encoding utf8
}
if ($dirty) {
  Step "pull_dirty" "Working tree has uncommitted changes; auto-aligning to origin/main (backup already saved)"
  $dirtyLog = "$LogFile.dirty"
  $dirty | Out-File -FilePath $dirtyLog -Encoding utf8
  Report-Error -Kind "upgrade_dirty_tree" -Detail "tracked files modified (git status --porcelain --untracked-files=no non-empty); auto reset --hard to origin/main; tree: $(Get-LastLogLines $dirtyLog)" -ContextFile $dirtyLog
  git fetch origin 2>&1 | Out-File -Append $LogFile -Encoding utf8
  if ($LASTEXITCODE -eq 0) {
    git reset --hard origin/main 2>&1 | Out-File -Append $LogFile -Encoding utf8
  }
  if ($LASTEXITCODE -ne 0) {
    Report-Error -Kind "upgrade_git_pull_failed" -Detail "fetch + reset --hard origin/main failed: $(Get-LastLogLines $LogFile)" -ContextFile $LogFile
    Pop-Location
    Rollback
    Fail "git_pull" "Force-align failed (network or permissions); $(RollbackNote)"
  }
  OK "pull" "Force-aligned (dirty changes overwritten; previous state in backup)"
} else {
  $pullOut = git pull --ff-only 2>&1
  # Capture the exit code before anything else runs.
  $pullCode = $LASTEXITCODE
  # v1.26.98 — $pullOut used to be captured and then dropped on the floor: it was never written
  # to $LogFile and never reached the server. That is why the 2026-08-07 19:26 failure produced
  # no upgrade log at all on Windows — nothing on this path ever wrote one. Writing it here is
  # what makes the log worth quoting; Get-LastLogLines below is what quotes it.
  $pullOut | Out-File -Append $LogFile -Encoding utf8
  if ($pullCode -ne 0) {
    # v1.26.144 — the one realistic failure here is an untracked file whose name a new
    # release has started tracking: --ff-only refuses rather than overwriting it. Naming the
    # untracked paths is what turns a stalled upgrade into one somebody can finish by hand.
    $untrackedNote = if ($untracked) { "; untracked: $($untracked -join ' ')" } else { "" }
    Report-Error -Kind "upgrade_git_pull_failed" -Detail "git pull --ff-only failed: $(Get-LastLogLines $LogFile)$untrackedNote" -ContextFile $LogFile
    Pop-Location
    Rollback
    Fail "git_pull" "git pull failed; $(RollbackNote)"
  }
  OK "pull" "git pull complete"
}

# --- 3. npm install (MCP) ---
$mcpDir = Join-Path $OwnMindDir "mcp"
if (Test-Path (Join-Path $mcpDir "package.json")) {
  Step "npm_install" "Updating MCP dependencies"
  Set-Location $mcpDir
  npm install --silent 2>&1 | Out-File -Append $LogFile -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    if (Test-FileLockError $LogFile) {
      Report-Error -Kind "upgrade_file_locked" -Detail "npm install hit file lock (likely Claude Code running): $(Get-LastLogLines $LogFile)" -ContextFile $LogFile
      Pop-Location
      Rollback
      Fail "file_locked" "Files in use by another process (likely Claude Code); $(RollbackNote). Close Claude Code completely, then re-run upgrade."
    }
    Report-Error -Kind "upgrade_npm_install_failed" -Detail "MCP npm install failed: $(Get-LastLogLines $LogFile)" -ContextFile $LogFile
    Pop-Location
    Rollback
    Fail "npm_install" "MCP npm install failed; $(RollbackNote)"
  }
  OK "npm_install" "MCP dependencies updated"
  Set-Location $OwnMindDir
}

# --- 4. Re-run install.ps1（從現有 ~/.claude/settings.json 讀 creds）---
#
# BUG FIX (v1.17.6): previously called `install.ps1 --update`, but install.ps1
# doesn't support `--update` — it parses $args[0] as API_KEY, so `--update`
# got treated as the key, leading to silent mis-configuration. Now mirrors
# the bash interactive-upgrade.sh pattern: read creds from settings.json
# and pass them as positional args.
Step "install" "Re-running install.ps1 (sync skills / hooks / scheduler)"
$installScript = Join-Path $OwnMindDir "install.ps1"
$claudeSettings = Join-Path $env:USERPROFILE ".claude\settings.json"
$apiKey = ""
$apiUrl = ""
if (Test-Path $claudeSettings) {
  try {
    $settings = Get-Content $claudeSettings -Raw | ConvertFrom-Json
    if ($settings.mcpServers -and $settings.mcpServers.ownmind -and $settings.mcpServers.ownmind.env) {
      $apiKey = $settings.mcpServers.ownmind.env.OWNMIND_API_KEY
      $apiUrl = $settings.mcpServers.ownmind.env.OWNMIND_API_URL
    }
  } catch { }
}

if (-not (Test-Path $installScript)) {
  Step "install" "install.ps1 not found; skipping (structure abnormal, reinstall recommended)"
} elseif ([string]::IsNullOrEmpty($apiKey) -or [string]::IsNullOrEmpty($apiUrl)) {
  Step "install" "No existing credentials; skipping install.ps1 re-run (skill/hook synced by update.sh)"
} else {
  & powershell -ExecutionPolicy Bypass -File $installScript $apiKey $apiUrl 2>&1 | Out-File -Append $LogFile -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    Pop-Location
    Rollback
    Fail "install" "install.ps1 failed (see $LogFile); $(RollbackNote)"
  }
  OK "install" "Setup complete"
}

# --- 5. Re-register Task Scheduler ---
$taskScript = Join-Path $OwnMindDir "scripts\windows\register-scanner-task.ps1"
if (Test-Path $taskScript) {
  Step "reschedule" "Re-registering Task Scheduler"
  & powershell -ExecutionPolicy Bypass -File $taskScript 2>&1 | Out-File -Append $LogFile -Encoding utf8
  if ($LASTEXITCODE -eq 0) { OK "reschedule" "Task Scheduler re-registered" }
  else {
    # v1.26.65 — 這裡以前印一句「upgrade itself complete」就繼續，最後回報升級成功。
    # 使用者看到綠燈，但用量收集已經停掉，而且沒有任何地方會講。Adam 因此斷了二十天。
    #
    # 不做 Rollback：檔案本身升級是好的，壞的只有排程。Fail 會 throw 並且送一筆
    # Report-Error 到 server，讓這件事在正式機留下紀錄，而不是只留在使用者螢幕上。
    Pop-Location
    Fail "reschedule" "Upgrade applied but the usage scanner schedule could not be registered; usage collection is stopped until it is (see $LogFile)"
  }
}

# --- 6. 驗測 + 清理 ---
# v1.17.66：bash 走 Find-GitBash helper 避開 WSL relay；
#           verify 失敗不再 Rollback（觀測 ≠ 升級成功與否的判定條件）
$verifyScript = Join-Path $OwnMindDir "scripts\verify-upgrade.sh"
if (Test-Path $verifyScript) {
  $findGitBashHelper = Join-Path $OwnMindDir 'scripts\windows\lib\find-git-bash.ps1'
  $bashExe = $null
  if (Test-Path $findGitBashHelper) {
    . $findGitBashHelper
    $bashExe = Find-GitBash
  }

  if (-not $bashExe) {
    # v1.26.99 — say which candidates were examined and why each was turned down. This line
    # used to read "Git Bash not found (install from https://git-scm.com/)" unconditionally,
    # which on a machine that has Git Bash is simply false, and it is the only output the
    # skipped verify produces. Get-GitBashSearchReport comes from the helper, so fall back
    # to a plain sentence when the helper itself is the thing that is missing.
    #
    # Folded through ConvertTo-OneLine like every other reported reason. The text is
    # assembled from exception messages and `bash --version` output, one per rejected
    # candidate: a newline in it makes the report invalid JSON and the whole thing is
    # dropped on arrival, and an unbounded length is the other way to lose it.
    $searchReport = if (Get-Command Get-GitBashSearchReport -ErrorAction SilentlyContinue) {
      Get-GitBashSearchReport
    } else {
      "find-git-bash.ps1 helper not present at $findGitBashHelper"
    }
    $searchSaid = ConvertTo-OneLine $searchReport
    Report-Error -Kind "upgrade_git_bash_not_usable" -Detail "verify skipped; $searchSaid" -ContextFile $LogFile
    Step "verify_local" "No usable Git Bash, skipping verify (upgrade continues) - $searchSaid"
  } else {
    Step "verify_local" "Verifying local components"
    & $bashExe $verifyScript --local 2>&1 | Out-File -Append $LogFile -Encoding utf8
    if ($LASTEXITCODE -eq 0) { OK "verify_local" "Local components present" }
    else { Step "verify_local" "Local verification failed (upgrade continues; self-check will observe)" }

    Step "verify_server" "Verifying server"
    & $bashExe $verifyScript --server 2>&1 | Out-File -Append $LogFile -Encoding utf8
    if ($LASTEXITCODE -eq 0) { OK "verify_server" "Server reachable" }
    else { Step "verify_server" "Server verification failed (possible network blip)" }

    Step "cleanup" "Cleaning up test data"
    & $bashExe $verifyScript --cleanup 2>&1 | Out-File -Append $LogFile -Encoding utf8 | Out-Null
    OK "cleanup" "Test data cleaned"
  }
}

Pop-Location

$pkg = Get-Content (Join-Path $OwnMindDir "package.json") -Raw | ConvertFrom-Json
$Version = $pkg.version

# --- 7. Dismiss 已過時的升級廣播（v1.17.18） ---
# 把 dismiss 從 AI skill 移到腳本（IR-027 邏輯卡控），對齊 .sh 行為。
if ($apiKey -and $apiUrl -and $Version) {
  Step "dismiss" "Dismissing stale upgrade broadcasts"
  try {
    $headers = @{
      "Authorization"     = "Bearer $apiKey"
      "X-Ownmind-Version" = "$Version"
    }
    $activeUrl = "$apiUrl/api/broadcast/active?tool=claude-code&client_version=$Version"
    $active = Invoke-RestMethod -Uri $activeUrl -Headers $headers -Method Get -TimeoutSec 5 -ErrorAction Stop
    $count = 0
    if ($active) {
      foreach ($b in @($active)) {
        if ($b.type -eq "upgrade_reminder" -and $b.id) {
          $body = @{ broadcast_id = [int]$b.id; tool = "claude-code" } | ConvertTo-Json -Compress
          try {
            Invoke-RestMethod -Uri "$apiUrl/api/broadcast/dismiss" -Headers $headers `
              -Method Post -ContentType "application/json" -Body $body -TimeoutSec 3 | Out-Null
            $count++
          } catch { }
        }
      }
    }
    OK "dismiss" "Upgrade broadcasts dismissed ($count)"
  } catch {
    Step "dismiss" "Dismiss failed (network or server blip); does not affect upgrade outcome"
  }
}

# v1.17.70：升級成功末段 sweep ~/.ownmind.bak.<ts>/ 超過 N 天的（IR-027 邏輯卡控）。
# 預設 7 天，可用 OWNMIND_BACKUP_RETENTION_DAYS 環境變數覆蓋。
# 防呆：sweep 失敗（權限 / 鎖定）不影響升級訊息，但用 STEP 記下 error message
# 給未來 debug 用（IR-038 觀測管道）。
$RetentionDays = if ($env:OWNMIND_BACKUP_RETENTION_DAYS) {
  [int]$env:OWNMIND_BACKUP_RETENTION_DAYS
} else { 7 }
Step "sweep" "Sweeping backups older than $RetentionDays days (if any)"
try {
  $cutoff = (Get-Date).AddDays(-$RetentionDays)
  Get-ChildItem -LiteralPath $HOME -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '.ownmind.bak.*' -and $_.LastWriteTime -lt $cutoff } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  OK "sweep" "Old backup sweep complete"
} catch {
  Step "sweep" "Sweep skipped (error: $($_.Exception.Message))"
}

OK "done" "Upgrade complete -> version $Version. Backup kept at $BackupDir (auto-swept after $RetentionDays days)"

# v1.17.86 — upgrade_complete beacon（IR-038 觀測管道補洞，跟 .sh 對稱）
# 比 self-check 早一步、payload 簡單 + 5 秒 timeout + spool fallback，
# 場景：升完了但 self-check 上傳沒成功（Bob / Dana 案例）→ server
# 至少看得到 upgrade_complete row 證明 user 升上去了、版本 X。
function Send-UpgradeCompleteBeacon {
  param([string]$ClientVersion)
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
      trigger = 'upgrade_complete'
      client_version = $ClientVersion
      platform = 'win32'
      machine = $machine
    } | ConvertTo-Json -Compress
    try {
      Invoke-RestMethod -Uri "$($apiUrl.TrimEnd('/'))/api/debug/install-check" `
        -Method POST `
        -Headers @{ Authorization = "Bearer $apiKey"; 'Content-Type' = 'application/json' } `
        -Body $body -TimeoutSec 5 -ErrorAction Stop | Out-Null
    } catch {
      try {
        $spoolFile = Join-Path $OwnMindDir 'logs\.upload-spool.jsonl'
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::AppendAllText($spoolFile, ($body + "`n"), $utf8NoBom)
      } catch { }
    }
  } catch { }
}
Send-UpgradeCompleteBeacon -ClientVersion $Version

}
catch {
  # v1.17.66 review fix — Fail() throw 的訊息（已含 ERROR:<code>:<msg> 前綴）
  # 在這裡統一印 stdout，再讓 finally 跑 self-check
  $errMsg = $null
  if ($_.Exception -and $_.Exception.Message) { $errMsg = $_.Exception.Message }
  if (-not $errMsg) { $errMsg = "$_" }
  Write-Host $errMsg
  $script:exitCode = 1
}
finally {
  # v1.17.66 — 不論升級成功失敗，self-check.cjs 一定要跑（IR-038 觀測管道）
  Run-SelfCheckOnce
}

exit $script:exitCode
