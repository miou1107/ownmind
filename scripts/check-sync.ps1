# check-sync.ps1 — three-layer OwnMind health check (Remote / Server / Deploy drift).
# Windows / PowerShell counterpart to check-sync.sh.
# Usage: powershell -ExecutionPolicy Bypass -File $HOME\.ownmind\scripts\check-sync.ps1
# Output: structured STDOUT for the ownmind-upgrade skill to parse.
#
# Never throws / non-zero exit (so the AI flow is never blocked); every error goes
# to STDOUT under an `error` tag.

$ErrorActionPreference = 'Continue'

$OwnmindDir = if ($env:OWNMIND_DIR) { $env:OWNMIND_DIR } else { Join-Path $HOME '.ownmind' }
$ClaudeDir  = if ($env:CLAUDE_DIR)  { $env:CLAUDE_DIR }  else { Join-Path $HOME '.claude' }

function Write-Tag([string]$line) { Write-Output $line }

# ============================================================
# L1 — Remote drift (~/.ownmind git HEAD vs origin/main)
# ============================================================
$L1 = 'unknown'
$L1Detail = ''
$gitDir = Join-Path $OwnmindDir '.git'
if (Test-Path $gitDir) {
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        git -C $OwnmindDir fetch origin main --quiet 2>$null | Out-Null
        $localHead  = (git -C $OwnmindDir rev-parse HEAD 2>$null)
        $remoteHead = (git -C $OwnmindDir rev-parse origin/main 2>$null)
        if ($localHead -and $remoteHead) {
            if ($localHead -eq $remoteHead) {
                $L1 = 'in_sync'
            } else {
                $behind = (git -C $OwnmindDir rev-list --count "HEAD..origin/main" 2>$null)
                if (-not $behind) { $behind = '?' }
                $L1 = 'behind'
                $L1Detail = "count=$behind"
            }
        } else {
            $L1 = 'error'
            $L1Detail = 'cannot_resolve_refs'
        }
    } else {
        $L1 = 'error'
        $L1Detail = 'git_not_installed'
    }
} else {
    $L1 = 'not_git'
}
if ($L1Detail) { Write-Tag "L1_REMOTE:$L1 $L1Detail" } else { Write-Tag "L1_REMOTE:$L1" }

# ============================================================
# L2 — Server version drift (client package.json vs server SERVER_VERSION)
# ============================================================
$L2 = 'unknown'
$L2Detail = ''
$ClientVer = ''
$ServerVer = ''

$pkgPath = Join-Path $OwnmindDir 'package.json'
if (Test-Path $pkgPath) {
    try {
        $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
        if ($pkg.version) { $ClientVer = [string]$pkg.version }
    } catch { }
    # File-lock fallback: regex parse if ConvertFrom-Json failed.
    if (-not $ClientVer) {
        try {
            $line = Select-String -Path $pkgPath -Pattern '"version"\s*:\s*"([^"]+)"' -List
            if ($line) { $ClientVer = $line.Matches[0].Groups[1].Value }
        } catch { }
    }
}

# Read API credentials from Claude settings.json.
$ApiKey = ''
$ApiUrl = ''
$settingsPath = Join-Path $ClaudeDir 'settings.json'
if (Test-Path $settingsPath) {
    try {
        $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
        $env_ = $settings.mcpServers.ownmind.env
        if ($env_) {
            if ($env_.OWNMIND_API_KEY) { $ApiKey = [string]$env_.OWNMIND_API_KEY }
            if ($env_.OWNMIND_API_URL) { $ApiUrl = [string]$env_.OWNMIND_API_URL }
        }
    } catch { }
}

if ($ApiKey -and $ApiUrl) {
    try {
        $resp = Invoke-RestMethod -Uri "$ApiUrl/api/memory/init" `
            -Headers @{ Authorization = "Bearer $ApiKey" } `
            -TimeoutSec 5 -ErrorAction Stop
        if ($resp.server_version) { $ServerVer = [string]$resp.server_version }
    } catch { }
}

function Parse-SemVer([string]$v) {
    # Returns @(major, minor, patch, stableFlag); stableFlag is 1 for stable, 0
    # for pre-release. A pre-release ranks below the matching stable.
    $noBuild = ($v -split '\+', 2)[0]
    $dashIdx = $noBuild.IndexOf('-')
    if ($dashIdx -eq -1) {
        $core = $noBuild
        $hasPre = $false
    } else {
        $core = $noBuild.Substring(0, $dashIdx)
        $hasPre = $noBuild.Substring($dashIdx + 1).Length -gt 0
    }
    $parts = @($core -split '\.')
    if ($parts.Count -lt 3) { return @(0, 0, 0, 0) }
    $nums = @(0, 0, 0)
    for ($i = 0; $i -lt 3; $i++) {
        $n = 0
        if (-not [int]::TryParse($parts[$i], [ref]$n)) { return @(0, 0, 0, 0) }
        $nums[$i] = $n
    }
    $stable = 1
    if ($hasPre) { $stable = 0 }
    return @($nums[0], $nums[1], $nums[2], $stable)
}

function Compare-SemVer([string]$a, [string]$b) {
    $pa = Parse-SemVer $a
    $pb = Parse-SemVer $b
    for ($i = 0; $i -lt 4; $i++) {
        if ($pa[$i] -ne $pb[$i]) {
            if ($pa[$i] -lt $pb[$i]) { return -1 } else { return 1 }
        }
    }
    return 0
}

if (-not $ClientVer) {
    $L2 = 'error'
    $L2Detail = 'cannot_read_client_version'
} elseif (-not $ServerVer) {
    $L2 = 'error'
    $L2Detail = 'cannot_reach_server'
} else {
    $cmp = Compare-SemVer $ClientVer $ServerVer
    switch ($cmp) {
        -1 { $L2 = 'outdated'; $L2Detail = "client=$ClientVer server=$ServerVer" }
         1 { $L2 = 'ahead';    $L2Detail = "client=$ClientVer server=$ServerVer" }
         0 { $L2 = 'in_sync';  $L2Detail = "version=$ClientVer" }
        default { $L2 = 'error'; $L2Detail = 'cmp_failed' }
    }
}
if ($L2Detail) { Write-Tag "L2_SERVER:$L2 $L2Detail" } else { Write-Tag "L2_SERVER:$L2" }

# ============================================================
# L3 — Deploy drift (~/.ownmind source vs ~/.claude deployed)
# ============================================================
$pairs = @(
    @{ src = (Join-Path $OwnmindDir 'hooks/ownmind-session-start.sh');   dst = (Join-Path $ClaudeDir 'hooks/ownmind-session-start.sh') },
    @{ src = (Join-Path $OwnmindDir 'hooks/ownmind-iron-rule-check.sh'); dst = (Join-Path $ClaudeDir 'hooks/ownmind-iron-rule-check.sh') },
    @{ src = (Join-Path $OwnmindDir 'hooks/ownmind-worktree-setup.sh');  dst = (Join-Path $ClaudeDir 'hooks/ownmind-worktree-setup.sh') },
    @{ src = (Join-Path $OwnmindDir 'skills/ownmind-memory.md');         dst = (Join-Path $ClaudeDir 'skills/ownmind-memory/SKILL.md') },
    @{ src = (Join-Path $OwnmindDir 'skills/ownmind-upgrade.md');        dst = (Join-Path $ClaudeDir 'skills/ownmind-upgrade/SKILL.md') }
)

# Dynamically add hooks/lib/*.js
$libDir = Join-Path $OwnmindDir 'hooks/lib'
if (Test-Path $libDir) {
    Get-ChildItem -Path $libDir -Filter '*.js' -File -ErrorAction SilentlyContinue | ForEach-Object {
        $pairs += @{ src = $_.FullName; dst = (Join-Path $ClaudeDir "hooks/lib/$($_.Name)") }
    }
}

# Dynamically add hooks/locales/*.json (gate-message-i18n task 7 — same pattern as
# hooks/lib above: install.ps1/update.ps1 ship these to the ~/.claude/hooks fallback too).
# The dot-name filter mirrors what those two now copy: PowerShell's '*.json' matches a
# leading dot where a POSIX glob does not, so without it this drift check would demand
# .translate-cache.json (a gitignored translate-pipeline artifact, never shipped) be present
# in ~/.claude/hooks/locales and report permanent drift on every Windows machine.
$localesDir = Join-Path $OwnmindDir 'hooks/locales'
if (Test-Path $localesDir) {
    Get-ChildItem -Path $localesDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '.*' } |
        ForEach-Object {
            $pairs += @{ src = $_.FullName; dst = (Join-Path $ClaudeDir "hooks/locales/$($_.Name)") }
        }
}

$driftCount = 0
$driftFiles = @()
foreach ($p in $pairs) {
    if (-not (Test-Path $p.src)) { continue }
    if (-not (Test-Path $p.dst)) {
        $driftCount++
        $driftFiles += "$($p.dst) (missing)"
        continue
    }
    try {
        $srcHash = (Get-FileHash -Path $p.src -Algorithm SHA1 -ErrorAction Stop).Hash
        $dstHash = (Get-FileHash -Path $p.dst -Algorithm SHA1 -ErrorAction Stop).Hash
        if ($srcHash -ne $dstHash) {
            $driftCount++
            $driftFiles += $p.dst
        }
    } catch { }
}

if ($driftCount -eq 0) {
    Write-Tag 'L3_DEPLOY:in_sync'
} else {
    Write-Tag "L3_DEPLOY:drifted count=$driftCount"
    foreach ($f in $driftFiles) { Write-Tag "L3_DRIFT_FILE:$f" }
}

# ============================================================
# OVERALL — any layer drifts → needs_upgrade.
# ============================================================
if ($L1 -eq 'behind' -or $L2 -eq 'outdated' -or $driftCount -gt 0) {
    Write-Tag 'OVERALL:needs_upgrade'
} elseif ($L1 -eq 'error' -or $L2 -eq 'error') {
    Write-Tag 'OVERALL:unknown_due_to_errors'
} else {
    Write-Tag 'OVERALL:in_sync'
}

exit 0
