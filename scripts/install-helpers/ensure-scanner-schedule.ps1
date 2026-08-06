# ensure-scanner-schedule.ps1 — repair the usage scanner's scheduled task if it has died.
#
# v1.26.79. Run on every auto-update, from update.ps1. Idempotent: a healthy task is left
# completely untouched, so the normal path costs one Get-ScheduledTask.
#
# Why this exists
# ---------------
# Measured on production 2026-08-06. Adam's collector heartbeat says it plainly: the
# claude-code row his MCP writes moved that morning carrying 1.26.67, while the four rows
# the scanner writes had not moved since 2026-07-15 and still carried 1.26.29. Files were
# upgraded the whole time. The scheduled task was gone for three weeks and the dashboard
# rendered his usage as blank, which reads like "he did not work".
#
# interactive-upgrade.ps1 has re-registered the task since v1.26.65, and its comment names
# Adam. It never reached him, because only bootstrap.ps1 calls it and nobody runs bootstrap
# by hand. The auto-update path is mcp/index.js -> update.ps1, and that path had never
# looked at the schedule at all. A repair only works if it lives on the road the failure
# actually travels.
#
# Contract
#   exit 0 — the task is present and enabled (either it already was, or it is now)
#   exit 1 — the task is absent or disabled and could not be restored
#
# Output is prefixed for machine reading, matching bootstrap.ps1:
#   OK:schedule:already_registered | OK:schedule:repaired | ERROR:schedule:<why>

$ErrorActionPreference = 'Continue'

# Git Bash / MSYS pollutes $HOME with /c/Users/xxx; force the Windows profile path.
if ($env:USERPROFILE -and ($HOME -ne $env:USERPROFILE)) {
  Set-Variable -Name HOME -Value $env:USERPROFILE -Force -Scope Global -ErrorAction SilentlyContinue
}

$OwnMindDir = if ($env:OWNMIND_DIR) { $env:OWNMIND_DIR } else { Join-Path $env:USERPROFILE '.ownmind' }
$TaskName = 'OwnMind Usage Scanner'

# Best-effort reporting, same pattern update.ps1 uses. A missing helper must never stop
# the repair itself.
$reportErrorHelper = Join-Path $OwnMindDir 'scripts\install-helpers\report-error.ps1'
if (Test-Path $reportErrorHelper) {
  . $reportErrorHelper
} else {
  function Report-Error { param($Kind, $Detail, $ContextFile = "") }
}

function Fail-Schedule {
  param([string]$Why)
  Write-Host "ERROR:schedule:$Why"
  Report-Error -Kind "scanner_schedule_repair_failed" -Detail $Why
  exit 1
}

# A disabled task is not a healthy task. Get-ScheduledTask returns one happily, and for
# the user the outcome is identical to having no task: it never fires, no data arrives.
# Checking presence alone would call Adam's machine healthy in one of the two ways it can
# be broken.
#
# -ErrorAction SilentlyContinue so an absent task is $null rather than a throw. Both reads
# below are written out rather than wrapped in a helper: the thing worth being able to see
# at a glance is that Task Scheduler is asked again *after* the repair, and a wrapper hides
# exactly that.
#
# -TaskPath '\' pins the query to the root folder, which is where register-scanner-task.ps1
# creates it (Register-ScheduledTask with no -TaskPath). Without it, a same-named task in
# some other folder joins the result, $task becomes an array, and `$task.State -ne
# 'Disabled'` stops being a boolean: PowerShell filters the array instead, and a non-empty
# array is truthy. A stranger's task would then vouch for ours being healthy.
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($task -and $task.State -ne 'Disabled') {
  Write-Host "OK:schedule:already_registered"
  exit 0
}

$registerScript = Join-Path $OwnMindDir 'scripts\windows\register-scanner-task.ps1'
if (-not (Test-Path $registerScript)) {
  Fail-Schedule "register-scanner-task.ps1 missing at $registerScript"
}

# Delegate rather than duplicate. register-scanner-task.ps1 owns node resolution, the VBS
# wrapper, the trigger shape and the -Force replace; a second copy of that here would
# drift from it the first time either is touched.
& powershell -ExecutionPolicy Bypass -File $registerScript 2>&1 | Out-Null
$registerExit = $LASTEXITCODE

# Ask Task Scheduler again rather than trusting the exit code. This repo has already
# shipped a release where registration reported success and the machine had no task on it
# (v1.17.66, two users). That is the defect this whole file exists to stop.
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if (-not $task) {
  Fail-Schedule "task '$TaskName' still absent after re-registering (register exit $registerExit)"
}
if ($task.State -eq 'Disabled') {
  Fail-Schedule "task '$TaskName' exists but is disabled after re-registering"
}

Write-Host "OK:schedule:repaired"
exit 0
