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

# v1.26.130 - two variables, because they answer two different questions.
#
# $ScriptDir is where this script's siblings are: $PSScriptRoot, not a path rebuilt from the
# environment. v1.26.129 was a release about a script executed from a copy whose siblings had
# not come with it; rebuilding the path is how that happens.
#
# $InstallDir is the answer to "which installation does the scheduled task have to drive",
# and it must be computed the same way in all three places that ask:
#   - scripts/windows/register-scanner-task.ps1, which writes the path into the task
#   - scripts/install-helpers/self-check.cjs, which reports a mismatch
#   - here, which repairs one
#
# All three use the Windows profile. This script used to honour $env:OWNMIND_DIR and the
# other two never have, which under a custom install path produced a repair that could not
# converge: the gate would reject the task, re-registration would write the profile path back
# again, the post-repair check would reject it a second time, and the machine would send a
# failed-repair report every single day. The override cannot be the shared value anyway - it
# is an install-time variable and is simply absent from the environment when the daily update
# runs. A custom install path therefore remains unsupported by the scheduler, exactly as it
# already was, rather than newly generating a daily error nobody can act on.
$ScriptDir = $PSScriptRoot
$InstallDir = Join-Path $env:USERPROFILE '.ownmind'
$TaskName = 'OwnMind Usage Scanner'

# Best-effort reporting, same pattern update.ps1 uses. A missing helper must never stop
# the repair itself.
$reportErrorHelper = Join-Path $ScriptDir 'report-error.ps1'
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

# v1.26.130 - the rule for "is this schedule healthy" lives in one dot-sourceable file so it
# can be executed by a test off Windows, and so it stays the twin of the JS rule the
# self-check reports with. Missing is a hard failure rather than a fall back to the old
# presence-only gate: silently answering the weaker question is the defect being fixed.
$healthHelper = Join-Path $ScriptDir 'schedule-health.ps1'
if (-not (Test-Path $healthHelper)) {
  Fail-Schedule "schedule-health.ps1 missing at $healthHelper"
}
. $healthHelper

# Three ways a registered task is not a working schedule, all of them measured on real
# machines, all of them decided by Test-ScheduleHealthy: disabled (v1.26.79), owned by
# another installation (v1.26.130, Adam and Eric), and a state we could not read.
#
# -ErrorAction SilentlyContinue so an absent task is $null rather than a throw. Both reads
# below are written out rather than wrapped in a helper: the thing worth being able to see
# at a glance is that Task Scheduler is asked again *after* the repair, and a wrapper hides
# exactly that.
#
# -TaskPath '\' pins the query to the root folder, which is where register-scanner-task.ps1
# creates it (Register-ScheduledTask with no -TaskPath). Without it, a same-named task in
# some other folder joins the result and $task becomes an array - its .State would then be
# an array too, and the health question stops having a single answer.
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($task -and (Test-ScheduleHealthy -State $task.State `
                                     -Actions (Get-TaskActionText $task) `
                                     -OwnMindDir $InstallDir)) {
  Write-Host "OK:schedule:already_registered"
  exit 0
}

$registerScript = Join-Path $ScriptDir '..\windows\register-scanner-task.ps1'
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
# register-scanner-task.ps1 replaces the task with -Force, so this should always hold. It is
# asserted anyway for the same reason the presence check above exists: this repo has shipped
# a release where registration reported success and the machine had nothing (v1.17.66), and
# "repaired" written onto a machine that is still broken is worse than an honest failure.
#
# One real way to get here: the task was created by a different Windows account, whose DACL
# grants us read but not write. -Force then throws under that script's 'Stop' preference and
# the foreign task survives.
#
# The message carries what the task actually points at, and where we expected it to point.
# This defect lived from v1.26.79 to v1.26.130 because the only report anyone saw never said
# that; repeating the omission in the new failure path would buy nothing.
$afterActions = Get-TaskActionText $task
if (-not (Test-TaskBelongsToInstall -Actions $afterActions -OwnMindDir $InstallDir)) {
  Fail-Schedule ("task '$TaskName' still points elsewhere after re-registering (register exit " `
    + "$registerExit); expected $InstallDir, task runs: $afterActions. If it was created by " `
    + "another Windows account, delete it in Task Scheduler as an administrator and let the " `
    + "next update re-create it")
}

Write-Host "OK:schedule:repaired"
exit 0
