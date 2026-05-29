import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * Windows compatibility checks (v1.17.9; reporters Bob + Alice)
 *
 * Bob's case: when calling install.ps1 from Git Bash, $HOME is POSIX-style
 * `/c/Users/Bob`. Concatenating with Windows paths yields odd results like
 * `C:\c\Users\Bob\...` and node writes files in the wrong place. Root cause:
 * Git Bash environment variables contaminate the child PowerShell process.
 *
 * Fix: every .ps1 must start with a normalization preamble that forces $HOME
 * to point at $env:USERPROFILE (the Windows-correct value).
 *
 * Also: the old interactive-upgrade.ps1 passed `--update` to install.ps1, which
 * was treated as an API key, causing a silent misconfiguration. install.ps1 now
 * must filter flag-like args.
 */

const PS1_FILES = [
  'install.ps1',
  'scripts/bootstrap.ps1',
  'scripts/interactive-upgrade.ps1',
  'scripts/windows/register-scanner-task.ps1',
];

function readPs1(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('PS1 Windows environment normalization preamble', () => {
  for (const rel of PS1_FILES) {
    it(`${rel} — includes $HOME → $env:USERPROFILE normalization`, () => {
      const content = readPs1(rel);
      // Two required pieces:
      // 1. Check that $env:USERPROFILE exists.
      // 2. Override $HOME (Set-Variable -Name HOME, or $global:HOME =, or equivalent).
      assert.match(
        content,
        /\$env:USERPROFILE/,
        `${rel} missing $env:USERPROFILE check`
      );
      assert.match(
        content,
        /Set-Variable\s+-Name\s+HOME|\$(?:global:)?HOME\s*=\s*\$env:USERPROFILE/,
        `${rel} missing $HOME override`
      );
    });
  }
});

describe('install.ps1 — flag-like args filtering (Bob / Alice workflow compatibility)', () => {
  const content = readPs1('install.ps1');

  it('filters out args starting with - (e.g. --update / -u)', () => {
    // Should include something like `Where-Object { $_ -notlike '-*' }`.
    assert.match(
      content,
      /Where-Object\s*\{\s*\$_\s+-notlike\s+'-\*'/,
      'install.ps1 does not filter flag-like args; legacy interactive-upgrade passing --update would be misread as the API key'
    );
  });

  it('falls back to the env var when filtered ApiKey is empty', () => {
    // Verify that when filtered args are empty, env:OWNMIND_API_KEY is still consulted.
    assert.match(
      content,
      /\$env:OWNMIND_API_KEY/,
      'install.ps1 must fall back to env:OWNMIND_API_KEY'
    );
  });
});

// ============================================================================
// v1.17.66 reproduction tests — Alice / Bob upgrade-to-v1.17.65 failure scenarios
// ============================================================================
//
// Live evidence (logs + code) for the seven bugs is recorded in:
//   openspec/changes/archive/v1.17.66-windows-hardening/proposal.md
//
// GIVEN/WHEN/THEN for the fixes:
//   openspec/changes/archive/v1.17.66-windows-hardening/spec.md
//
// This file holds the "must hold after the fix" assertions. They are red before
// the fix and turn green after.
// ============================================================================

describe('v1.17.66 — Bug #1 PowerShell must not bare `bash` (sidestep WSL relay)', () => {
  it('scripts/windows/lib/find-git-bash.ps1 helper exists', () => {
    assert.ok(
      fs.existsSync(path.join(repoRoot, 'scripts/windows/lib/find-git-bash.ps1')),
      'helper file missing; v1.17.66 must create this helper'
    );
  });

  it('find-git-bash.ps1 includes Test-IsGitBash + excludes the System32 WSL relay', () => {
    const content = readPs1('scripts/windows/lib/find-git-bash.ps1');
    assert.match(content, /function\s+Test-IsGitBash/i,
      'must define Test-IsGitBash to distinguish Git Bash from the WSL relay');
    assert.match(content, /System32\\bash\.exe/i,
      'must explicitly exclude C:\\Windows\\System32\\bash.exe (the WSL relay)');
    assert.match(content, /function\s+Find-GitBash/i,
      'must define the Find-GitBash main function');
  });

  it('interactive-upgrade.ps1 no longer bare-`bash`-invokes the verify script', () => {
    const content = readPs1('scripts/interactive-upgrade.ps1');
    // After the fix, use & $BashExe $verifyScript, with $BashExe from Find-GitBash.
    assert.match(content, /Find-GitBash/,
      'interactive-upgrade.ps1 must reference Find-GitBash helper (no bare `bash` — that would hit the WSL relay)');
    // The bare `bash $verifyScript` pattern must be gone.
    assert.doesNotMatch(content, /^\s*bash\s+\$verifyScript/m,
      'no more bare `bash $verifyScript`; must go through Find-GitBash');
  });
});

describe('v1.17.66 — Bug #6 PowerShell Out-File must use UTF-8 encoding', () => {
  // Alice's upgrade-20260508-094901.log had garbled Chinese because Out-File defaults
  // to UTF-16 LE with BOM. Every Out-File / Set-Content / Add-Content in .ps1 must
  // pass -Encoding utf8.
  for (const rel of PS1_FILES) {
    it(`${rel} — Out-File always uses -Encoding utf8`, () => {
      const content = readPs1(rel);
      // Find every Out-File occurrence; each must include -Encoding utf8 within ~50 chars.
      const re = /Out-File[^\n]*/g;
      const matches = content.match(re) || [];
      for (const m of matches) {
        assert.match(m, /-Encoding\s+utf8/i,
          `Out-File is missing -Encoding utf8 (writes UTF-16 LE BOM, garbles Chinese): "${m}"`);
      }
    });
  }
});

describe('v1.17.66 — Bug #7 Scanner hidden window + battery settings', () => {
  it('scripts/windows/run-hidden.vbs launcher exists', () => {
    assert.ok(
      fs.existsSync(path.join(repoRoot, 'scripts/windows/run-hidden.vbs')),
      'VBS launcher missing; the Scanner window-hiding fix depends on it'
    );
  });

  it('register-scanner-task.ps1 uses wscript.exe + run-hidden.vbs (no direct -Execute node.exe)', () => {
    const content = readPs1('scripts/windows/register-scanner-task.ps1');
    assert.match(content, /wscript\.exe/i,
      'task action should switch to wscript.exe (GUI subsystem; no console window)');
    assert.match(content, /run-hidden\.vbs/i,
      'task action should invoke the run-hidden.vbs launcher');
    // Must no longer "-Execute $NodeBin" against node.exe directly (node.exe is a console binary that pops a window).
    const actionLine = content.match(/New-ScheduledTaskAction[\s\S]*?(?=\n\$)/);
    if (actionLine) {
      assert.doesNotMatch(actionLine[0], /-Execute\s+\$NodeBin\b/,
        'task action must not -Execute $NodeBin (node.exe is a console binary; pops a window)');
    }
  });

  // v1.17.67 fix: v1.17.66 tried to add battery-friendly settings, but
  // -DontStartIfOnBatteries and -StopIfGoingOnBatteries are not valid parameters
  // of New-ScheduledTaskSettingsSet (the real names are -DisallowStartIfOnBatteries /
  // -DontStopIfGoingOnBatteries). Both PS 5.1 and PS 7 throw immediately → the task
  // is never registered (Bob and Alice both hit this). Since PowerShell's defaults
  // already give us "do not start on battery" + "stop when switching to battery",
  // setting these explicitly is redundant — just remove them.
  it('register-scanner-task.ps1 must not contain the two misspelled battery params from v1.17.66', () => {
    const content = readPs1('scripts/windows/register-scanner-task.ps1');
    // Strip PowerShell line comments (# to end-of-line); otherwise comments
    // explaining the bug could mention the broken param names and trip the check.
    const code = content.replace(/(^|\s)#[^\n]*/g, '$1');
    assert.doesNotMatch(code, /-DontStartIfOnBatteries\b/,
      '-DontStartIfOnBatteries is not a valid PowerShell parameter (correct: -DisallowStartIfOnBatteries). ' +
      'PS already defaults to "do not start on battery"; just leave it unset.');
    assert.doesNotMatch(code, /-StopIfGoingOnBatteries\b/,
      '-StopIfGoingOnBatteries is not a valid PowerShell parameter (correct: -DontStopIfGoingOnBatteries is the inverse switch). ' +
      'PS already defaults to "stop when switching to battery"; just leave it unset.');
  });

  // IR-007 Persistent Bug Protocol: v1.17.66's original test only asserted the string
  // existed in the file. "string present" ≠ "PowerShell accepts the param". Switch to a
  // whitelist comparison so a future misspelling is caught.
  it('register-scanner-task.ps1 New-ScheduledTaskSettingsSet params must all be valid PowerShell names', () => {
    const content = readPs1('scripts/windows/register-scanner-task.ps1');

    // Parameters common to PowerShell 5.1 and 7 New-ScheduledTaskSettingsSet.
    // Source: Microsoft Docs ScheduledTasks module (Windows Server 2012+).
    // Maintenance policy: every new param must come from the official docs and
    // be verified on PS 5.1 via Get-Help.
    const VALID_PARAMS = new Set([
      'AllowDemandStart', 'AllowHardTerminate', 'AllowStartIfOnBatteries',
      'Compatibility', 'DeleteExpiredTaskAfter', 'Disable',
      'DisallowDemandStart', 'DisallowHardTerminate', 'DisallowStartIfOnBatteries',
      'DontStopIfGoingOnBatteries', 'DontStopOnIdleEnd',
      'ExecutionTimeLimit', 'Hidden',
      'IdleDuration', 'IdleWaitTimeout',
      'MaintenanceDeadline', 'MaintenanceExclusive', 'MaintenancePeriod',
      'MultipleInstances', 'NetworkId', 'NetworkName',
      'Priority', 'RestartCount', 'RestartInterval', 'RestartOnIdle',
      'RunOnlyIfIdle', 'RunOnlyIfNetworkAvailable',
      'StartWhenAvailable', 'WakeToRun',
    ]);

    // Strip PowerShell line comments first (# to end-of-line); otherwise the regex
    // would match cmdlet names appearing inside comments that exist purely to explain
    // the bug, and we would treat a comment block as an actual cmdlet block — missing
    // a real bug (v1.17.67 code review caught this when injecting -BogusFakeParam still
    // resulted in green tests).
    const codeOnly = content.replace(/(^|\s)#[^\n]*/g, '$1');

    // Grab the entire New-ScheduledTaskSettingsSet ` line-continuation block.
    const blockMatch = codeOnly.match(/New-ScheduledTaskSettingsSet[\s\S]*?(?=\n\$|\n\n|\nRegister-)/);
    assert.ok(blockMatch, 'New-ScheduledTaskSettingsSet block not found');

    // First, strip out inner ( ... ) function calls (e.g. New-TimeSpan -Minutes 10)
    // so their params are not counted as params of New-ScheduledTaskSettingsSet.
    let stripped = blockMatch[0];
    let prev;
    do {
      prev = stripped;
      stripped = stripped.replace(/\([^()]*\)/g, '');
    } while (stripped !== prev);

    const usedParams = [...stripped.matchAll(/(?<![\w-])-([A-Z][A-Za-z0-9]+)\b/g)]
      .map((m) => m[1]);

    const unknownParams = usedParams.filter((p) => !VALID_PARAMS.has(p));
    assert.deepEqual(unknownParams, [],
      `register-scanner-task.ps1 uses params PowerShell does not recognize: ${unknownParams.join(', ')}. ` +
      `These throw on both PS 5.1 / 7 and the task is never registered. Cross-reference Microsoft Docs to fix.`);
  });

  it('register-scanner-task.ps1 RepetitionInterval is changed to 120 minutes (30→120)', () => {
    const content = readPs1('scripts/windows/register-scanner-task.ps1');
    assert.match(content, /-RepetitionInterval\s+\(New-TimeSpan\s+-Minutes\s+120\)/,
      'RepetitionInterval should change from 30 minutes to 120 minutes (lower background load)');
    assert.doesNotMatch(content, /-RepetitionInterval\s+\(New-TimeSpan\s+-Minutes\s+30\)/,
      'the old 30-minute interval should be replaced');
  });
});

describe('v1.17.66 — Bug #4 self-check upload is guaranteed (try/finally)', () => {
  it('interactive-upgrade.ps1 self-check runs in try/finally so it executes even on verify failure', () => {
    const content = readPs1('scripts/interactive-upgrade.ps1');
    // Fix: the self-check.cjs call must sit inside a finally block, guaranteed to run
    // even when verify fails / Fail exits.
    assert.match(content, /\bfinally\s*\{[\s\S]*self-check\.cjs/,
      'self-check.cjs must live in a finally block (guarantees the observability pipe runs — IR-038)');
  });
});
