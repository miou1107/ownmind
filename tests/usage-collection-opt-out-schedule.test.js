/**
 * Issue #200, item 4 — a machine whose owner turned usage collection off.
 *
 * `~/.ownmind/.no-usage-scanner` tells install.sh / install.ps1 not to register the scanner's
 * schedule, and tells run-scanner.sh to exit at once. Two other places had never heard of it:
 *
 *   - the self-check reported the missing schedule as a failure on every run, so the admin was
 *     warned about a choice the owner made on purpose;
 *   - the daily repair (ensure-scanner-schedule.sh / .ps1) put the schedule straight back.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selfCheck = require(path.join(repoRoot, 'scripts/install-helpers/self-check.cjs'));
const ENSURE_SH = path.join(repoRoot, 'scripts/install-helpers/ensure-scanner-schedule.sh');
const ENSURE_PS1 = path.join(repoRoot, 'scripts/install-helpers/ensure-scanner-schedule.ps1');

function ownmindDir({ optedOut }) {
  const dir = tempDir('ownmind-optout-');
  if (optedOut) fs.writeFileSync(path.join(dir, '.no-usage-scanner'), '');
  return dir;
}

describe('issue #200 — usage collection turned off', () => {
  it('the self-check passes the scheduler item instead of failing it', async () => {
    const dir = ownmindDir({ optedOut: true });
    // A platform with no scheduler branch at all: if the opt-out were not checked first, this
    // would fall through to whatever the function returns for an unknown platform.
    for (const platform of ['darwin', 'linux', 'win32']) {
      const r = await selfCheck.checkScheduler({ ownmindDir: dir, platform });
      assert.equal(r.status, 'pass', `${platform}: an opted-out machine is not a failure`);
      assert.equal(r.detail, selfCheck.SCHEDULER_OPTED_OUT_DETAIL);
    }
  });

  it('without the opt-out file the check still asks the scheduler', async () => {
    // The other half: the opt-out must not become a blanket pass. On this platform the
    // real query runs; whatever it says, it is not the opted-out answer.
    const dir = ownmindDir({ optedOut: false });
    const r = await selfCheck.checkScheduler({ ownmindDir: dir });
    assert.notEqual(r.detail, selfCheck.SCHEDULER_OPTED_OUT_DETAIL);
  });

  it('the daily repair leaves an opted-out machine without a schedule', () => {
    const dir = ownmindDir({ optedOut: true });
    // darwin: without the opt-out this branch would call launchctl and write a launch agent.
    // OWNMIND_PWSH points at a command that fails, so the Windows branch could not pass by
    // accident either.
    for (const os_ of ['darwin23', 'linux-gnu', 'msys']) {
      const r = spawnSync('bash', [ENSURE_SH], {
        encoding: 'utf8',
        env: { ...process.env, OWNMIND_DIR: dir, OWNMIND_OS: os_, OWNMIND_PWSH: 'false', HOME: dir },
      });
      assert.equal(r.status, 0, `${os_}: ${r.stderr}`);
      assert.equal(r.stdout.trim(), 'OK:schedule:opted_out', os_);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'Library')), 'no launch agent was written');
  });

  it('the Windows repair checks the opt-out before it asks Task Scheduler', () => {
    const src = fs.readFileSync(ENSURE_PS1, 'utf8');
    const optOut = src.indexOf("'.no-usage-scanner'");
    const query = src.indexOf('Get-ScheduledTask -TaskName');
    assert.ok(optOut > 0, 'the Windows repair has no opt-out check');
    assert.ok(optOut < query, 'the opt-out has to be checked before the task is queried or repaired');
    assert.match(src.slice(optOut, query), /OK:schedule:opted_out[\s\S]*exit 0/);
  });
});
