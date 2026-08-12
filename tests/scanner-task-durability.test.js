// v1.26.65 — why a Windows scanner dies quietly and stays dead.
//
// Traced from production on 2026-08-05. `~/.ownmind/package.json` is a single
// source read by both the MCP and the scanner. On Adam's machine the MCP reads
// 1.26.59 today while the scanner's last heartbeat, on 2026-07-15, carried
// 1.26.29. The files were upgraded; the scanner has not run once since. Twenty
// days passed before anyone noticed.
//
// Three defects in our own code turn a momentary failure into permanent silent
// data loss. These tests pin each one shut. They read the script text rather
// than execute it, which is the right level here and the level the existing
// ps1-windows-compat.test.js already works at: the defects are structural.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// Strip PowerShell comments so prose about a cmdlet is never mistaken for a call.
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('register-scanner-task.ps1 — registering must not be able to leave nothing behind', () => {
  const src = codeOnly(read('scripts/windows/register-scanner-task.ps1'));

  it('never deletes the existing task before its replacement exists', () => {
    // The script sets $ErrorActionPreference = 'Stop'. With a delete step ahead
    // of the create step, any failure in between leaves the machine with no
    // scheduled task at all, forever, with nothing reported.
    //
    // This is not hypothetical. The comments in this very file record v1.17.66
    // shipping two invalid New-ScheduledTaskSettingsSet parameters that threw on
    // both PowerShell 5.1 and 7 — "task 完全沒註冊", hit by two users on upgrade.
    // The parameters were fixed. The shape that turned a typo into permanent
    // data loss was not.
    assert.doesNotMatch(
      src,
      /Unregister-ScheduledTask/,
      'delete-then-create has no rollback; use Register-ScheduledTask -Force, which replaces in one call',
    );
  });

  it('registers with -Force, so replacing an existing task is a single operation', () => {
    const block = src.match(/Register-ScheduledTask[\s\S]*?(?=\n\n|\nWrite-|$)/);
    assert.ok(block, 'Register-ScheduledTask call not found');
    assert.match(block[0], /-Force\b/);
  });

  it('confirms the task is really there before reporting success', () => {
    // Register-ScheduledTask returning without throwing is good evidence but not
    // proof, and the one failure this repo has already lived through produced a
    // machine with no task on it. Checking costs one call.
    const after = src.slice(src.indexOf('Register-ScheduledTask'));
    assert.match(after, /Get-ScheduledTask/,
      'nothing verifies the task exists after registration');
  });

  it('uses only real Register-ScheduledTask parameter names', () => {
    // Same guard the file already applies to New-ScheduledTaskSettingsSet, for
    // the same reason: an invented parameter name throws at runtime on the user's
    // machine and nowhere else.
    const VALID = new Set([
      'TaskName', 'TaskPath', 'Action', 'Trigger', 'Settings', 'Principal',
      'User', 'Password', 'Description', 'Xml', 'InputObject', 'Force',
      'AsJob', 'CimSession', 'ThrottleLimit',
      'ErrorAction', 'ErrorVariable', 'WarningAction', 'Verbose', 'Debug',
    ]);
    const block = src.match(/Register-ScheduledTask[\s\S]*?(?=\n\n|\nWrite-|$)/);
    const used = [...block[0].matchAll(/\s-([A-Za-z]+)/g)].map((m) => m[1]);
    const unknown = used.filter((p) => !VALID.has(p));
    assert.deepEqual(unknown, [], `not real Register-ScheduledTask parameters: ${unknown.join(', ')}`);
  });
});

describe('run-hidden.vbs — the exit code Task Scheduler records must mean something', () => {
  const src = read('scripts/windows/run-hidden.vbs');

  it('waits for the process it launched', () => {
    // WScript.Shell.Run's third argument is bWaitOnReturn. With False the method
    // returns immediately and always yields 0, so wscript.exe exits 0 whether
    // node ran, crashed, or was never there at all. Task Scheduler records that
    // as LastTaskResult 0, "success".
    //
    // The consequence is worse than a missing signal: the documented diagnostic
    // for this exact fault is "check LastTaskResult, 0 means it worked", and that
    // check cannot fail. It would have told Adam his dead scanner was healthy.
    assert.doesNotMatch(src, /sh\.Run[^\n]*,\s*False/i,
      'fire-and-forget makes every run report success');
    assert.match(src, /sh\.Run[^\n]*,\s*True/i);
  });

  it('passes the real exit code back to Task Scheduler', () => {
    // A variable, not a literal: `WScript.Quit 1` for the empty-argument guard
    // must not be mistaken for propagating a result.
    assert.match(src, /WScript\.Quit\s+[A-Za-z_]\w*/,
      'the launched process exit code must become wscript.exe exit code');
  });
});

describe('the scanner must not exit 0 when it did nothing', () => {
  // The MCP reads process.env.OWNMIND_API_KEY, handed to it by the IDE. The
  // scanner is a scheduled task with no environment to inherit, so it has to find
  // and parse ~/.claude/settings.json itself. Two credential paths, and only the
  // MCP's is exercised by the component that keeps working.
  //
  // When the scanner's path breaks it logged one line to a local file and exited
  // 0. Every layer above then reported success. readCredentials already carries a
  // comment about this happening to two users through a BOM; that cause was
  // patched and the silence was not.
  it('exits non-zero when it cannot find credentials', async () => {
    const { spawnSync } = await import('node:child_process');
    const os = await import('node:os');
    const home = tempDir('ownmind-scanner-');

    try {
      const run = spawnSync(process.execPath, ['hooks/ownmind-usage-scanner.js'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf8',
        timeout: 30_000,
      });

      assert.notEqual(run.status, 0,
        'a run that collected nothing must not report success; run-hidden.vbs now '
        + 'passes this straight through to Task Scheduler LastTaskResult');

      const logPath = path.join(home, '.ownmind', 'logs', 'scanner.log');
      assert.ok(fs.existsSync(logPath), 'the reason must still be written locally');
      assert.match(fs.readFileSync(logPath, 'utf8'), /credentials/i);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('interactive-upgrade.ps1 — a lost scheduled task is not a footnote', () => {
  const src = codeOnly(read('scripts/interactive-upgrade.ps1'));

  it('does not report a successful upgrade after failing to re-register the scanner', () => {
    // The old branch printed "Task Scheduler re-register failed; upgrade itself
    // complete" and carried on to a green result. The user sees a successful
    // upgrade and has silently lost usage collection.
    const section = src.slice(src.indexOf('$taskScript'));
    const branch = section.slice(0, section.indexOf('verifyScript'));
    assert.doesNotMatch(branch, /upgrade itself complete/i);
    assert.match(branch, /Fail\s+"reschedule"/,
      're-registration failure must fail the upgrade, not annotate it');
  });
});
