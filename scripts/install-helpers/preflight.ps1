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
# Note the one requirement this cannot report to the server: Report-Error runs node. A machine
# with no node gets the message on screen and nothing in the admin console, and there is no way
# around that from here.

Set-StrictMode -Version Latest

# The lowest Node the test matrix covers (.github/workflows/test.yml: ubuntu/macos/windows on
# 20, ubuntu also on 24). Anything below that is untested rather than merely old, which is why
# it is a stop and not a warning. Raise this here and the check follows.
$script:OwnMindNodeFloor = 20

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

function Get-OwnMindNodeMajor {
  param([Parameter(Mandatory = $true)][string]$NodeExe)
  try {
    $raw = & $NodeExe --version 2>$null
    if ($LASTEXITCODE -ne 0) { return -1 }
    if ("$raw" -match 'v?(\d+)\.') { return [int]$Matches[1] }
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

  $node = Get-OwnMindToolPath 'node'
  if (-not $node) {
    & $add 'node' 'node is not on PATH; the memory server, the self-check and the error reporter all run on it' `
      'winget install --id OpenJS.NodeJS.LTS -e --source winget    (then open a new terminal so PATH is picked up)'
  } else {
    $major = Get-OwnMindNodeMajor $node
    if ($major -lt 0) {
      & $add 'node' "node at $node did not answer --version, so it cannot be used" `
        'winget install --id OpenJS.NodeJS.LTS -e --source winget    (then open a new terminal so PATH is picked up)'
    } elseif ($major -lt $script:OwnMindNodeFloor) {
      & $add 'node' "node $major is below the oldest version OwnMind is tested on ($script:OwnMindNodeFloor)" `
        'winget install --id OpenJS.NodeJS.LTS -e --source winget    (then open a new terminal so PATH is picked up)'
    }
  }

  # npm ships with node, so a node that is present and an npm that is not means a broken or
  # partial install — a shim from nvs/Volta/Scoop that resolves and does not run. Asking it for
  # a version is the difference between "the file is there" and "it works", and that difference
  # is the whole reason this file exists.
  $npm = Get-OwnMindToolPath 'npm'
  if (-not $npm) {
    & $add 'npm' 'npm is not on PATH; the memory server installs its dependencies with it' `
      'npm ships with Node.js — reinstall it: winget install --id OpenJS.NodeJS.LTS -e --source winget'
  } else {
    $npmOk = $false
    try { & $npm --version 2>$null | Out-Null; $npmOk = ($LASTEXITCODE -eq 0) } catch { $npmOk = $false }
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

  $failures = Test-OwnMindRequirements
  if ($failures.Count -eq 0) { return $true }

  Write-Host ""
  Write-Host "ERROR:preflight:This machine is missing $($failures.Count) thing(s) OwnMind needs. Nothing has been changed." -ForegroundColor Red
  foreach ($f in $failures) {
    Write-Host "ERROR:preflight_$($f.Name):$($f.Problem)" -ForegroundColor Red
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
