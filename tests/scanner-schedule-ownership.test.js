/**
 * v1.26.130 — the repair that runs on every update could not see the failure the check
 * on the same machine was reporting.
 *
 * Measured on production 2026-08-10. Two users, Adam and Eric, both on 1.26.125:
 *
 *     scheduler failed | Task Scheduler entry points at another installation,
 *                        not C:\Users\Adam\.ownmind
 *
 * self-check.cjs found that because v1.26.124 taught it to compare the task's actions
 * against this installation's directory (see scheduler-task-owner.cjs). But self-check only
 * reports. The thing that repairs — ensure-scanner-schedule.ps1, run from update.ps1 on
 * every auto-update — asked a weaker question:
 *
 *     if ($task -and $task.State -ne 'Disabled') { "already_registered"; exit 0 }
 *
 * Their task exists and is enabled. It just drives a different directory. So the repair
 * declared both machines healthy and returned, every single day, while the report kept
 * saying they were broken. Visible and unfixable: upgrading does not help them, and there
 * is nothing else on the machine that would.
 *
 * The rule now lives in one dot-sourceable file so the decision can be executed here rather
 * than matched as text. Text-level assertions are the level the rest of the PowerShell in
 * this repo is pinned at, and they would not have caught this defect — the old gate reads
 * perfectly well; it asks the wrong question.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const { taskBelongsToInstall } = require('../scripts/install-helpers/scheduler-task-owner.cjs');

const HEALTH_PS1 = 'scripts/install-helpers/schedule-health.ps1';
const HELPER_PS1 = 'scripts/install-helpers/ensure-scanner-schedule.ps1';

/**
 * Every PowerShell on this machine, not the first one found.
 *
 * `scripts/update.ps1` runs this helper as `& powershell` — Windows PowerShell 5.1, still the
 * Windows 10 default. A first-match probe picks pwsh 7 on the Windows runner and 5.1, the
 * version production actually executes, is never exercised at all. Both are checked wherever
 * both exist; on Linux and macOS runners that is pwsh alone.
 */
const SHELLS = ['pwsh', 'powershell'].filter((exe) => {
  const r = spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
  return r.status === 0;
});

const noPowerShell = SHELLS.length > 0
  ? false
  : 'no PowerShell on this machine; the CI runners have it and run these for real';

/**
 * Run one call against the helper and return the boolean it produced.
 *
 * The file's own text is prepended rather than dot-sourced by path. Same effect — the whole
 * file still has to parse and define what it claims — with no dependency on where the
 * checkout is mounted, which matters because the only way to execute PowerShell on a macOS
 * dev machine is a container. That ensure-scanner-schedule.ps1 dot-sources the file is
 * asserted separately, below.
 *
 * Arguments go through the environment rather than the command line: these are Windows
 * paths full of backslashes and quotes, and interpolating them into a -Command string is
 * how a test ends up asserting against its own escaping instead of the function.
 */
function evalPs(exe, expression, env) {
  const script = `${read(HEALTH_PS1)}\n${expression}`;
  // -ExecutionPolicy Bypass because a Windows client that never configured a policy is
  // Restricted; tests/windows-test-hygiene.test.js pins this on every spawn that runs a
  // script rather than a literal.
  const r = spawnSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `${exe} exited ${r.status}: ${r.stderr}`);
  const out = r.stdout.trim();
  assert.match(out, /^(True|False)$/, `${exe} returned no boolean: ${JSON.stringify(out)}`);
  return out === 'True';
}

/** Assert the same expectation against every PowerShell present, naming the one that broke. */
function eachShell(expression, env, expected, message) {
  for (const exe of SHELLS) {
    assert.equal(evalPs(exe, expression, env), expected, `${message} (under ${exe})`);
  }
}

const belongs = (actions, dir, expected, message) => eachShell(
  'Test-TaskBelongsToInstall -Actions $env:PS_ACTIONS -OwnMindDir $env:PS_DIR',
  { PS_ACTIONS: actions, PS_DIR: dir },
  expected, message,
);

const healthy = (state, actions, dir, expected, message) => eachShell(
  'Test-ScheduleHealthy -State $env:PS_STATE -Actions $env:PS_ACTIONS -OwnMindDir $env:PS_DIR',
  { PS_STATE: state, PS_ACTIONS: actions, PS_DIR: dir },
  expected, message,
);

// The action string Windows reports for a real registration, taken from the one measured in
// v1.26.124. `ADAMS` is the same task seen from the installation that does not own it —
// which is exactly what Adam's and Eric's machines have.
const OURS = String.raw`wscript.exe "C:\Users\Vin\.ownmind\scripts\windows\run-hidden.vbs" "C:\Program Files\nodejs\node.exe" "C:\Users\Vin\.ownmind\hooks\ownmind-usage-scanner.js"`;
const ADAM_DIR = String.raw`C:\Users\Adam\.ownmind`;

/**
 * The cases both implementations have to agree on. One table, two languages: the JS copy
 * decides what gets reported and the PowerShell copy decides what gets repaired, and a
 * disagreement between them is precisely the defect this release fixes.
 */
const OWNERSHIP_CASES = [
  { name: 'the install the task actually drives', actions: OURS, dir: String.raw`C:\Users\Vin\.ownmind`, expect: true },
  { name: "Adam's machine — the task belongs to somebody else", actions: OURS, dir: ADAM_DIR, expect: false },
  { name: 'forward slashes', actions: OURS, dir: 'C:/Users/Vin/.ownmind', expect: true },
  { name: 'different case', actions: OURS, dir: String.raw`c:\users\vin\.ownmind`, expect: true },
  { name: 'trailing separator', actions: OURS, dir: 'C:\\Users\\Vin\\.ownmind\\', expect: true },
  { name: 'unreadable actions are "cannot tell", not "wrong"', actions: '', dir: ADAM_DIR, expect: true },
  { name: 'whitespace-only actions are also "cannot tell"', actions: '   ', dir: ADAM_DIR, expect: true },
  { name: 'an unknown install directory cannot convict a task', actions: OURS, dir: '', expect: true },
];

describe('the PowerShell repair asks the same ownership question the check asks', () => {
  it('the rule is in a file the repair can dot-source', () => {
    assert.ok(fs.existsSync(path.join(repoRoot, HEALTH_PS1)),
      `${HEALTH_PS1} is missing; the ownership rule has no home on the Windows side`);
  });

  it('CI really has a PowerShell to run these against', { skip: process.env.CI ? false : 'local' }, () => {
    // Everything below skips itself when no shell is found. That is right on a dev machine
    // and wrong on CI: the runners are the only place these ever execute, and a probe that
    // silently stopped matching would turn the whole file into a source-text check without
    // anything going red.
    assert.ok(SHELLS.length > 0,
      'no PowerShell found on a CI runner — the probe is stale and these tests are now vacuous');
  });

  for (const c of OWNERSHIP_CASES) {
    it(`${c.name} — PowerShell agrees with the JS rule`, { skip: noPowerShell }, () => {
      // Both sides asserted against the same expectation rather than against each other:
      // two implementations that agree on the wrong answer would still pass a pure
      // parity check (IR-128).
      assert.equal(taskBelongsToInstall(c.actions, c.dir), c.expect, 'the JS rule disagrees');
      belongs(c.actions, c.dir, c.expect, 'the PowerShell rule disagrees');
    });
  }
});

describe('what the repair treats as a healthy schedule', () => {
  it("Adam's task is not healthy — this is the whole defect", { skip: noPowerShell }, () => {
    // Enabled, present, State=Ready. The old gate returned "already_registered" here and
    // walked away, every day, on a machine the self-check was calling broken.
    healthy('Ready', OURS, ADAM_DIR, false, 'a task owned by another install was called healthy');
  });

  it('a task that belongs here and is enabled is left alone', { skip: noPowerShell }, () => {
    healthy('Ready', OURS, String.raw`C:\Users\Vin\.ownmind`, true, 'Ready must be left alone');
    healthy('Running', OURS, String.raw`C:\Users\Vin\.ownmind`, true, 'Running must be left alone');
  });

  it('a disabled task is still broken, ownership notwithstanding', { skip: noPowerShell }, () => {
    // v1.26.79's rule, kept: a task that never fires is the same outcome as no task.
    healthy('Disabled', OURS, String.raw`C:\Users\Vin\.ownmind`, false, 'a disabled task is not a schedule');
  });

  it('an unreadable state is not evidence of health', { skip: noPowerShell }, () => {
    // self-check.cjs treats a missing state as "not found" rather than as OK; the repair
    // must not be more generous than the check, or the two disagree again.
    healthy('', OURS, String.raw`C:\Users\Vin\.ownmind`, false, 'an unreadable state must not pass');
  });
});

describe('ensure-scanner-schedule.ps1 uses the rule', () => {
  it('the gate consults ownership, not just presence and state', () => {
    const src = codeOnly(read(HELPER_PS1));
    const gate = src.slice(0, src.indexOf('register-scanner-task.ps1'));
    assert.match(gate, /Test-ScheduleHealthy/,
      'the health gate still asks only whether a task exists and is enabled, so a task '
      + 'belonging to another installation is credited as healthy — Adam and Eric, 2026-08-10');
  });

  it('it dot-sources the rule rather than keeping a third copy', () => {
    const src = codeOnly(read(HELPER_PS1));
    assert.match(src, /schedule-health\.ps1/,
      'the ownership rule must have one home on the Windows side');
  });

  it('the verification after repairing checks ownership too', () => {
    // Re-registering is what fixes this, and register-scanner-task.ps1 replaces the task
    // with -Force. If it somehow did not, saying "repaired" would be the v1.17.66 defect
    // again: reporting success onto a machine that still has nothing working.
    const src = codeOnly(read(HELPER_PS1));
    const after = src.slice(src.lastIndexOf('register-scanner-task.ps1'));
    assert.match(after, /Test-TaskBelongsToInstall|Test-ScheduleHealthy/,
      'nothing confirms the re-registered task belongs to this installation');
  });

  it('reverse control: the gate slice really is the part before the repair', () => {
    // Otherwise a rename of register-scanner-task.ps1 would make the gate assertion above
    // read the whole file and pass on the call in the verification block instead.
    const src = codeOnly(read(HELPER_PS1));
    assert.ok(src.indexOf('register-scanner-task.ps1') > 0,
      'the repair no longer delegates to register-scanner-task.ps1; these slices need rewriting');
  });
});
