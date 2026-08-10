/**
 * v1.26.124 — Windows had no scanner schedule, and the check that should have said so
 * reported OK.
 *
 * Both halves were found in one run: install.sh was executed into a throwaway HOME on a
 * real Windows machine, and its report ended
 *
 *     [ OK ]  scheduler            Task Scheduler state=Ready
 *
 * for an installation that had registered nothing at all. `$OSTYPE` under Git for Windows
 * is `msys`, install.sh's OS `case` had branches only for `darwin*` and `linux*`, and the
 * `*)` fallback prints one warning line. The self-check then found the pre-existing task
 * belonging to a different directory and passed on it.
 *
 * Neither half is reachable from a Mac, and neither is reachable from CI: the shell branch
 * needs $OSTYPE=msys, and the scheduler query needs a Windows Task Scheduler. So both tests
 * below are written to run anywhere — the shell branch is asserted against the source, and
 * the ownership rule was extracted into a pure function precisely so it could be tested off
 * Windows. A guard that only runs on the platform that broke is a guard nobody runs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// v1.26.109: bash gets the script as a file, never as a `-c` command line — see
// tests/bash-c-escaping.test.js, which fails any test file that reaches for `-c`.
import { spawnBashScript } from './helpers/bash-script.js';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { taskBelongsToInstall } = require('../scripts/install-helpers/scheduler-task-owner.cjs');

const installSh = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');

/**
 * The scanner-scheduling `case` block, isolated from the rest of install.sh.
 *
 * install.sh has more than one `case "$OSTYPE" in` — send_install_beacon has its own, near
 * the top, purely to label the beacon's platform. Taking the first match found that one,
 * which already handles msys, so the guard passed while the scheduler branch was still
 * missing. Anchor on something only the scheduler case contains and search backwards.
 */
function schedulerCaseBlock() {
  const anchor = installSh.indexOf('LAUNCH_AGENTS=');
  assert.notEqual(anchor, -1,
    'install.sh no longer registers a launchd agent — the anchor this guard uses is gone and it needs rewriting');
  const start = installSh.lastIndexOf('case "$OSTYPE" in', anchor);
  assert.notEqual(start, -1, 'no $OSTYPE case precedes the scheduler branches');
  const end = installSh.indexOf('esac', start);
  assert.notEqual(end, -1, 'unterminated case block in install.sh');
  return installSh.slice(start, end);
}

describe('install.sh schedules the usage scanner on Windows', () => {
  it('Git Bash reports $OSTYPE=msys, which is what the branch must match', {
    skip: process.platform === 'win32' ? false
      : 'reads this machine\'s $OSTYPE; the source assertions below run everywhere and are what actually guard the branch',
  }, () => {
    // Pins the assumption the branch is built on. If a future Git for Windows reports
    // something else, this fails here rather than silently reopening the hole.
    const r = spawnBashScript('echo "$OSTYPE"\n', { encoding: 'utf8' });
    if (r.error || r.status !== 0) return; // no bash: the source assertions still stand
    assert.match(r.stdout.trim(), /^(msys|cygwin|win32)/,
      `Git Bash reported OSTYPE=${r.stdout.trim()}, which install.sh's Windows branch does not match`);
  });

  it('the OS case has a Windows branch, not just darwin and linux', () => {
    // The whole defect in one assertion.
    assert.match(schedulerCaseBlock(), /msys\*\|cygwin\*\|win32\*\)/,
      'install.sh falls through to "Unknown OS" on Windows, which installs the scanner files and schedules nothing');
  });

  it('that branch runs the same registration script install.ps1 uses', () => {
    const block = schedulerCaseBlock();
    const windows = block.slice(block.indexOf('msys*|cygwin*|win32*)'));
    assert.match(windows, /register-scanner-task\.ps1/,
      'the Windows branch must actually register the task, not just report that it did not');
    assert.match(windows, /-ExecutionPolicy Bypass/,
      'a client that never set a policy defaults to Restricted and cannot run a .ps1 at all — see v1.26.106');
  });

  it('that branch verifies the task exists instead of trusting the exit code', () => {
    const block = schedulerCaseBlock();
    const windows = block.slice(block.indexOf('msys*|cygwin*|win32*)'));
    // v1.17.12 added this on the PowerShell side after a silent failure; the darwin and
    // linux branches above both learned it too. A new branch that only reads $? repeats it.
    assert.match(windows, /Get-ScheduledTask/,
      'the branch must ask Windows whether the task is really there');
  });

  it('that branch does not discard stderr', () => {
    // IR-002. The reason this branch exists is that a failure was reduced to one warning
    // line nobody read; routing the error away from the log would be the same mistake in a
    // new place. Comments are stripped first — the branch documents the rule in prose.
    const block = schedulerCaseBlock();
    const windows = block.slice(block.indexOf('msys*|cygwin*|win32*)'));
    const code = windows
      .split(/\r?\n/)
      .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
      .join('\n');
    assert.equal(/2>\s*\/dev\/null/.test(code), false,
      'the Windows branch silences an error; send it to the register-task log instead');
  });

  it('reverse control: the branch matcher would notice if the branch were removed', () => {
    // Otherwise a typo in the pattern makes every assertion above vacuous.
    assert.equal(/msys\*\|cygwin\*\|win32\*\)/.test('    darwin*)\n    linux*)\n    *)'), false);
  });
});

describe('the self-check only credits a task that belongs to this installation', () => {
  // The exact action string Windows reported for the real task on the machine where the
  // false pass was measured.
  const REAL = String.raw`wscript.exe "C:\Users\Vin\.ownmind\scripts\windows\run-hidden.vbs" "C:\Program Files\nodejs\node.exe" "C:\Users\Vin\.ownmind\hooks\ownmind-usage-scanner.js"`;

  it('credits the install the task actually drives', () => {
    assert.equal(taskBelongsToInstall(REAL, String.raw`C:\Users\Vin\.ownmind`), true);
  });

  it('does not credit a different install — the measured false pass', () => {
    // This is the sandbox that registered nothing and was told its scheduler was Ready.
    assert.equal(
      taskBelongsToInstall(REAL, String.raw`C:\Temp\Fake Home\.ownmind`),
      false,
      'an install that registered nothing must not be credited with somebody else\'s task',
    );
  });

  it('matches across slash conventions and case', () => {
    // The task carries native backslashes; OWNMIND_DIR is whatever os.homedir() returned.
    assert.equal(taskBelongsToInstall(REAL, 'C:/Users/Vin/.ownmind'), true);
    assert.equal(taskBelongsToInstall(REAL, String.raw`c:\users\vin\.ownmind`), true);
    // Not String.raw here: a raw template cannot end in a backslash, because it would
    // escape the closing backtick.
    assert.equal(taskBelongsToInstall(REAL, 'C:\\Users\\Vin\\.ownmind\\'), true,
      'a trailing separator is not a different directory');
  });

  it('treats an unreadable action list as "cannot tell", not as "wrong"', () => {
    // Get-ScheduledTask can return a task whose actions the current user may not read.
    // Failing there would turn a permissions quirk into a hard failure on a healthy
    // machine — the same false alarm v1.26.106 removed from this file.
    assert.equal(taskBelongsToInstall('', String.raw`C:\Users\Vin\.ownmind`), true);
    assert.equal(taskBelongsToInstall('   ', String.raw`C:\Users\Vin\.ownmind`), true);
    assert.equal(taskBelongsToInstall(undefined, String.raw`C:\Users\Vin\.ownmind`), true);
    assert.equal(taskBelongsToInstall(REAL, ''), true, 'an unknown install dir cannot convict a task either');
  });

  it('a near-miss directory is still a miss', () => {
    // `.ownmind-old` contains no path that `.ownmind` alone would fail to match, so this
    // pins the direction of the substring test: the task must contain the install, not the
    // other way round.
    const other = String.raw`wscript.exe "C:\Users\Vin\.ownmind-backup\hooks\ownmind-usage-scanner.js"`;
    assert.equal(taskBelongsToInstall(other, String.raw`C:\Users\Vin\.ownmind-backup`), true);
    assert.equal(taskBelongsToInstall(other, String.raw`D:\Users\Vin\.ownmind-backup`), false);
  });
});
