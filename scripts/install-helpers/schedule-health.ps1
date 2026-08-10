# schedule-health.ps1 - is the registered scanner task healthy, and is it ours?
#
# v1.26.130. Dot-sourced by ensure-scanner-schedule.ps1. Defines functions and nothing else,
# so sourcing it has no side effects.
#
# Why this is its own file
# ------------------------
# The repair used to gate on `$task -and $task.State -ne 'Disabled'`. Measured on production
# 2026-08-10, two users on 1.26.125 were being reported as
#
#     scheduler failed | Task Scheduler entry points at another installation,
#                        not C:\Users\Adam\.ownmind
#
# by self-check.cjs, which has compared the task's actions against the installation
# directory since v1.26.124. Their task existed and was enabled, so the repair said
# "already_registered" and returned - every day, on a machine the check on the same machine
# was calling broken. Nothing else would ever have fixed it, upgrading included.
#
# Get-ScheduledTask is machine-global: the task name alone says a task exists somewhere, not
# that this installation registered it. That is the same trap scheduler-task-owner.cjs was
# extracted for, and the rule here is deliberately the twin of the one in that file.
#
# Kept as pure string logic with no Task Scheduler cmdlets so the decision can be executed
# off Windows - tests/scanner-schedule-ownership.test.js runs these functions against the
# same case table as the JS copy. A repair rule that can only be read as text is a repair
# rule nobody has run; the old gate read perfectly well and asked the wrong question.
#
# Windows PowerShell 5.1 compatible: no ternaries, no null-coalescing, no .NET beyond 4.0.

<#
.SYNOPSIS
  Normalize a Windows path for comparison: slashes, case, and a trailing separator.
#>
function Get-ComparablePath {
  param([string]$Value)
  if ([string]::IsNullOrEmpty($Value)) { return '' }
  return ($Value -replace '\\', '/').ToLowerInvariant().TrimEnd('/')
}

<#
.SYNOPSIS
  Does the task's action list drive this installation?
.DESCRIPTION
  Mirrors taskBelongsToInstall() in scheduler-task-owner.cjs, including its refusal to
  convict on missing evidence: Get-ScheduledTask can return a task whose actions the current
  user is not allowed to read, and turning a permissions quirk into a repair - which
  re-registers the task - would be worse than leaving a healthy machine alone.
.PARAMETER Actions
  The task's actions, executable and arguments, joined into one string.
.PARAMETER OwnMindDir
  This installation's directory.
#>
function Test-TaskBelongsToInstall {
  param([string]$Actions, [string]$OwnMindDir)
  if ([string]::IsNullOrWhiteSpace($Actions)) { return $true }
  if ([string]::IsNullOrWhiteSpace($OwnMindDir)) { return $true }
  return (Get-ComparablePath $Actions).Contains((Get-ComparablePath $OwnMindDir))
}

<#
.SYNOPSIS
  Should the repair leave this task alone?
.DESCRIPTION
  Three ways a registered task is still not a working schedule, and the gate has to know all
  of them:
    - Disabled. It exists and never fires, which for the user is no task at all (v1.26.79).
    - Owned by another installation. This one (v1.26.130).
    - State unreadable. self-check.cjs treats a missing state as "not found" rather than as
      OK; the repair must not be more generous than the check, or the two disagree again and
      the user is back to a report nothing acts on.
.PARAMETER State
  The task's State, as Get-ScheduledTask reported it.
#>
function Test-ScheduleHealthy {
  param([string]$State, [string]$Actions, [string]$OwnMindDir)
  if ([string]::IsNullOrWhiteSpace($State)) { return $false }
  if ($State -eq 'Disabled') { return $false }
  return (Test-TaskBelongsToInstall -Actions $Actions -OwnMindDir $OwnMindDir)
}
