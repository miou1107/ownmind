/**
 * v1.32.15 — a Windows scheduler query that ran out of time reported the task as broken.
 *
 * Measured on production 2026-10-19. One member's laptop had passed the scheduler check on
 * all fourteen self-checks since 2026-09-02 (`Task Scheduler state=Ready`). The fifteenth,
 * run by the auto-update at 09:17, sent:
 *
 *     fail  Get-ScheduledTask failed: timed out signal=SIGTERM Command failed: powershell.exe ...
 *
 * The server announces every `fail`, so the admin got a two-day warning. Three hours later
 * the same laptop's scanner — the thing that task launches — had run and uploaded that
 * day's usage. Nothing was wrong with the task; the query did not answer within
 * CIM_TIMEOUT_MS during the busiest moment the machine has.
 *
 * The file already states the rule this broke. CIM_TIMEOUT_MS: "exceeding it means 'cannot
 * tell'". checkMcpLaunches: "a timeout maps to `warn`, never `fail`". The Windows scheduler
 * check, which runs the slowest query in the file under that very budget, still turned a
 * timeout into a fail.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selfCheckPath = path.join(repoRoot, 'scripts/install-helpers/self-check.cjs');
const selfCheck = require(selfCheckPath);

/** What safeSpawn returned for the measured run, command shortened. */
const TIMED_OUT = {
  ok: false,
  killed: true,
  signal: 'SIGTERM',
  error: "Command failed: powershell.exe -NoProfile -Command $t = Get-ScheduledTask -TaskName 'OwnMind Usage Scanner'",
};

/** A query that answered, with an error: PowerShell itself is the problem. */
const EXITED = {
  ok: false,
  killed: false,
  code: 1,
  stderr_tail: 'The term Get-ScheduledTask is not recognized',
  error: 'Command failed: powershell.exe -NoProfile -Command ...',
};

describe('v1.32.15 — a scheduler query that ran out of time', () => {
  it('is reported as unknown, so the server does not announce it', () => {
    const r = selfCheck.schedulerQueryResult(TIMED_OUT);
    assert.equal(r.name, 'scheduler');
    assert.equal(r.status, 'warn',
      'a query that did not answer said nothing about the task, and a fail is announced to the admin');
    assert.match(r.detail, /did not answer within 30s/);
  });

  it('a query that answered with an error is still a failure', () => {
    // The other half of the rule. Without it, turning every failed query into a warn would
    // pass the test above and hide the machine that really cannot run PowerShell.
    const r = selfCheck.schedulerQueryResult(EXITED);
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /^Get-ScheduledTask failed: code=1/);
  });

  it('the Windows branch of checkScheduler goes through it', () => {
    // checkScheduler picks its branch from process.platform at load time, so the Windows
    // branch cannot be run here. Read it instead: a failed query must be handed to the
    // function above rather than mapped to a result on the spot.
    const source = fs.readFileSync(selfCheckPath, 'utf8');
    const start = source.indexOf("if (PLATFORM === 'win32') {", source.indexOf('async function checkScheduler()'));
    const branch = source.slice(start, source.indexOf('const allLines', start));
    assert.match(branch, /if \(!r\.ok\) return schedulerQueryResult\(r\);/);
  });
});
