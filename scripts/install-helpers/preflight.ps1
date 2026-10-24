# Environment preflight for the Windows install and upgrade paths (#98).
#
# A teammate ran the documented one-liner on a machine with OwnMind installed and no `git` on
# PATH. bootstrap.ps1 delegated to interactive-upgrade.ps1, which backed up ~/.ownmind and then
# died on its first `git` call with nothing but PowerShell's raw "command not found" text. No
# ERROR: line, no Report-Error, and a stray .ownmind.bak.* directory left behind. Nothing in
# bootstrap.ps1, interactive-upgrade.ps1 or scripts/install-helpers/*.ps1 had ever asked whether
# the tools these scripts are built on were reachable.
#
# Two properties this file exists for:
#
#  1. It reports EVERY failing requirement in one pass. A machine missing both git and node
#     otherwise costs two round-trips with the person running it.
#  2. It runs BEFORE anything is moved. The backup in that incident was pure litter, because
#     the upgrade it protected never started.
#
# The remedy is printed inline as the exact command to run, not a link to a page. Somebody who
# just watched an install die is not going to go reading.
#
# Zero-touch install (this file mirrors preflight.sh):
#
#  - git is how a checkout is updated. An install from the release archive has no .git and never
#    calls git, so a missing git is not a failure when $OwnmindDir\.git does not exist.
#  - A missing or old node is not something the person has to fix: the installer downloads a
#    private Node into ~/.ownmind/runtime (ensure-node-runtime.ps1). It is still listed, with
#    "(no action needed)" as the remedy, so the report says what is about to happen; Assert-
#    OwnMindRequirements does not count it. npm comes with that Node, so it is not asked about.
#
# Note the one requirement this cannot report to the server: Report-Error runs node. A machine
# with no node gets the message on screen and nothing in the admin console, and there is no way
# around that from here.

Set-StrictMode -Version Latest

# The lowest Node the test matrix covers (.github/workflows/test.yml: ubuntu/macos/windows on
# 20, ubuntu also on 24). Anything below that is untested rather than merely old, which is why
# it is a stop and not a warning. Raise this here and the check follows.
$script:OwnMindNodeFloor = 20

# The remedy of a line that is only informational; Assert-OwnMindRequirements skips it.
$script:OwnMindPreflightNoAction = '(no action needed)'

function Get-OwnMindToolPath {
  param([Parameter(Mandatory = $true)][string]$Name)
  # -CommandType Application on purpose: a PowerShell alias or function of the same name is not
  # a program the scripts can invoke, and `git` resolving to somebody's profile alias would read
  # as present here and fail later exactly the way this file exists to stop.
  $found = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue
  if (-not $found) { return '' }
  if ($found -is [array]) { $found = $found[0] }
  return [string]$found.Source
}

# `$LASTEXITCODE` does not exist until a native command has run in this session, and under
# Set-StrictMode reading it then throws rather than returning $null. Every read of it in this
# file goes through here, so a program that fails to launch at all reports "could not run"
# instead of taking the preflight down with it.
function Get-OwnMindLastExit {
  if (Test-Path variable:LASTEXITCODE) { return $LASTEXITCODE }
  return -1
}

function Get-OwnMindNodeMajor {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$NodeExe)
  if (-not $NodeExe) { return -1 }
  try {
    $raw = & $NodeExe --version 2>$null
    if ((Get-OwnMindLastExit) -ne 0) { return -1 }
    # Anchored: node prints `v20.11.1` and nothing else, but a version manager's shim can print
    # its own banner first, and an unanchored match would read that banner's number as node's.
    if ("$raw".Trim() -match '^v?(\d+)\.') { return [int]$Matches[1] }
    return -1
  } catch { return -1 }
}

<#
.SYNOPSIS
  Every requirement this machine does not meet, as objects with Name, Problem and Remedy.
.DESCRIPTION
  Returns an empty array when the machine is ready. Never throws and never writes to the host,
  so a caller can decide what to do with the result — the tests call it directly.
#>
function Test-OwnMindRequirements {
  $failures = New-Object System.Collections.ArrayList

  $add = {
    param($name, $problem, $remedy)
    [void]$failures.Add([pscustomobject]@{ Name = $name; Problem = $problem; Remedy = $remedy })
  }

  # PowerShell itself. The whole Windows path is written against 5.1 semantics; below that the
  # scripts do not parse, so this is the one check whose failure the caller may never see.
  $psv = $PSVersionTable.PSVersion
  if ($psv.Major -lt 5 -or ($psv.Major -eq 5 -and $psv.Minor -lt 1)) {
    & $add 'powershell' "Windows PowerShell $psv is too old; these scripts are written for 5.1" `
      'Install Windows Management Framework 5.1, or run this from PowerShell 7: winget install --id Microsoft.PowerShell -e --source winget'
  }

  $git = Get-OwnMindToolPath 'git'
  if (-not $git) {
    & $add 'git' 'git is not on PATH; the installer clones and pulls with it' `
      'winget install --id Git.Git -e --source winget    (then open a new terminal so PATH is picked up)'
  }

  # A missing, silent or old node is replaced by the private runtime, so it is reported as
  # informational and npm (which comes with that runtime) is not asked about.
  $nodePrivate = $false
  $node = Get-OwnMindToolPath 'node'
  if (-not $node) {
    & $add 'node' 'private runtime will be installed' $script:OwnMindPreflightNoAction
    $nodePrivate = $true
  } else {
    $major = Get-OwnMindNodeMajor $node
    if ($major -lt 0 -or $major -lt $script:OwnMindNodeFloor) {
      & $add 'node' 'private runtime will be installed' $script:OwnMindPreflightNoAction
      $nodePrivate = $true
    }
  }

  # npm ships with node, so a node that is present and an npm that is not means a broken or
  # partial install — a shim from nvs/Volta/Scoop that resolves and does not run. Asking it for
  # a version is the difference between "the file is there" and "it works", and that difference
  # is the whole reason this file exists.
  $npm = ''
  if (-not $nodePrivate) { $npm = Get-OwnMindToolPath 'npm' }
  if ($nodePrivate) {
    # npm comes with the private runtime; nothing to check yet.
  } elseif (-not $npm) {
    & $add 'npm' 'npm is not on PATH; the memory server installs its dependencies with it' `
      'npm ships with Node.js — reinstall it: winget install --id OpenJS.NodeJS.LTS -e --source winget'
  } else {
    $npmOk = $false
    try { & $npm --version 2>$null | Out-Null; $npmOk = ((Get-OwnMindLastExit) -eq 0) } catch { $npmOk = $false }
    if (-not $npmOk) {
      & $add 'npm' "npm at $npm is on PATH but does not run" `
        'npm ships with Node.js — reinstall it: winget install --id OpenJS.NodeJS.LTS -e --source winget'
    }
  }

  # The leading comma keeps this an array. PowerShell unrolls a returned collection, so an
  # empty one yields nothing at all and `$x = Test-OwnMindRequirements` lands as $null — under
  # Set-StrictMode the `.Count` below would then throw, turning "this machine is fine" into a
  # crash. A one-element result has the mirror problem: it arrives as a bare object with no
  # .Count either.
  return ,@($failures.ToArray())
}

<#
.SYNOPSIS
  Print every unmet requirement, report each one, and stop the run.
.PARAMETER Stage
  Goes into the Report-Error kind, so the console can tell an install from an upgrade.
.DESCRIPTION
  Returns $true when the machine is ready. When it is not, it writes one ERROR: line per
  requirement and returns $false — the caller exits. It does not exit by itself, because
  interactive-upgrade.ps1 needs its own finally block to run.
#>
function Assert-OwnMindRequirements {
  param([string]$Stage = 'install')

  # The informational lines are not failures. git is only a failure for a git checkout: an
  # archive install has no .git and never calls it.
  #
  # Assign first, then pipe. Test-OwnMindRequirements returns its array wrapped (`,@(...)`) so that
  # an empty result stays an array; piped straight into Where-Object that wrapper is ONE object,
  # `$_` is the whole array, `$_.Remedy` is empty and a healthy machine counts as one failure.
  # A plain assignment unwraps it, and an empty array stays an empty array.
  $all = Test-OwnMindRequirements
  if ($null -eq $all) { $all = @() }
  $failures = @($all | Where-Object { $_.Remedy -ne $script:OwnMindPreflightNoAction })
  $ownmindDir = $env:OWNMIND_DIR
  if (-not $ownmindDir) { $ownmindDir = Join-Path $HOME '.ownmind' }
  if (-not (Test-Path -LiteralPath (Join-Path $ownmindDir '.git'))) {
    $failures = @($failures | Where-Object { $_.Name -ne 'git' })
  }
  if ($failures.Count -eq 0) { return $true }

  Write-Host ""
  Write-Host "ERROR:preflight:This machine is missing $($failures.Count) thing(s) OwnMind needs. Nothing has been changed." -ForegroundColor Red
  foreach ($f in $failures) {
    # `preflight_missing_<tool>`, matching bootstrap.ps1, preflight.sh and the reported kind.
    Write-Host "ERROR:preflight_missing_$($f.Name):$($f.Problem)" -ForegroundColor Red
    Write-Host "  fix: $($f.Remedy)"
    try {
      if (Get-Command Report-Error -ErrorAction SilentlyContinue) {
        Report-Error -Kind "preflight_missing_$($f.Name)" -Detail "$Stage - $($f.Problem)"
      }
    } catch { }
  }
  Write-Host ""
  Write-Host "Fix the above and run the same command again."
  return $false
}
