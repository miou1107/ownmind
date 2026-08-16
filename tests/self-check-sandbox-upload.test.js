/**
 * A test install must not report as the machine it is running on.
 *
 * 2026-08-16, measured: somebody built a throwaway HOME on their Windows machine and ran
 * install.sh in it, with PowerShell taken off PATH so the test could not overwrite the one
 * real scheduled task. The self-check at the end correctly found two failures — a sandbox
 * has no ~/.claude.json and no PowerShell — and uploaded them under the machine's hostname,
 * because a sandbox shares the hostname of whatever it runs on.
 *
 * The server then did exactly the right thing with a machine reporting two red checks and
 * warned the user. The machine had been healthy throughout: a re-run in the real environment
 * two hours later was 15 passed, 0 failed.
 *
 * The cost was not the wrong line on a screen. It was several hours, an SSH session into
 * production to read the uploaded reports, and a fix built for a fault that never existed.
 * The one after that costs more, because a warning that turns out to be noise is how the
 * true one gets ignored.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tempDir } from './helpers/temp-dir.js';

const require = createRequire(import.meta.url);
const { uploadReport, checkHomeIsAccountHome } = require('../scripts/install-helpers/self-check.cjs');

const REPORT = {
  ts: '2026-08-16T02:30:36.132Z',
  machine: 'TANK',
  client_version: '1.30.7',
  checks: [{ name: 'scheduler', status: 'fail', detail: 'spawn powershell.exe ENOENT' }],
  summary: { pass: 12, warn: 1, fail: 2 },
};

test('a run under somebody else\'s home is not this machine\'s health, and is not sent', async () => {
  const spoolDir = tempDir('om-sandbox-spool-');
  const result = await uploadReport(REPORT, 'https://example.invalid', 'key', {
    runningHome: '/tmp/throwaway-home',
    accountHome: '/Users/someone',
    // `spoolDir`, which is the option appendSpool actually reads. An earlier draft passed
    // `spoolFile` — a name nothing looks at — so the assertion below never bit, and running
    // the mutation check wrote five fabricated TANK reports into this machine's own spool,
    // queued to upload as its health on the next real run. The same bug as the report this
    // file exists for, committed inside the test written to prevent it.
    spoolDir,
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'not_this_account_home');
  assert.ok(!result.ok, 'a skipped upload must never read as a successful one');
});

test('and it is not spooled either, or it arrives late instead of never', async () => {
  // Spooling would be the same bug with a delay: the report reaches the server on the next
  // real run, still carrying the sandbox's failures and the real machine's hostname.
  const spoolDir = tempDir('om-sandbox-spool2-');
  await uploadReport(REPORT, 'https://example.invalid', 'key', {
    runningHome: '/tmp/throwaway-home',
    accountHome: '/Users/someone',
    spoolDir,
  });
  const queued = fs.existsSync(spoolDir) ? fs.readdirSync(spoolDir) : [];
  assert.deepEqual(queued, [], `the sandbox report was queued for later delivery: ${queued}`);
});

test('this suite spools into a temporary directory, and never into the real one', async () => {
  // Asserted, not assumed. The redirect is one option name away from being ignored, and when
  // it was, the mutation check queued five fabricated reports into this machine's own spool —
  // to be uploaded as its health on the next real run. The failure this suite is about,
  // committed inside the suite written to prevent it.
  const spoolDir = tempDir('om-spool-redirect-');
  await uploadReport(REPORT, '', '', { runningHome: '/Users/x', accountHome: '/Users/x', spoolDir });
  assert.deepEqual(
    fs.readdirSync(spoolDir).length > 0, true,
    'nothing landed in the temporary spool, so the option this suite passes is not the one the spool reads',
  );
});

test('a normal run is untouched by any of this', async () => {
  // The guard must be invisible on the path everybody is actually on. It returns a real
  // upload attempt here — the endpoint is unreachable, which is fine: what matters is that
  // it was attempted rather than skipped.
  const spoolDir = tempDir('om-normal-');
  const result = await uploadReport(REPORT, 'http://127.0.0.1:1', 'key', {
    runningHome: '/Users/someone',
    accountHome: '/Users/someone',
    // `spoolDir`, which is the option appendSpool actually reads. An earlier draft passed
    // `spoolFile` — a name nothing looks at — so the assertion below never bit, and running
    // the mutation check wrote five fabricated TANK reports into this machine's own spool,
    // queued to upload as its health on the next real run. The same bug as the report this
    // file exists for, committed inside the test written to prevent it.
    spoolDir,
  });
  assert.notEqual(result.reason, 'not_this_account_home');
});

test('a machine whose account home cannot be read still uploads', async () => {
  // Fails towards uploading on purpose. A machine we cannot judge is not a machine to go
  // quiet about — that trades a false alarm for a blind spot, which is the worse of the two.
  const undecided = checkHomeIsAccountHome({
    runningHome: '/anything',
    accountHome: null,
  });
  assert.equal(undecided.real, true);
  assert.match(undecided.undecided, /unknown/);
});

test('the same home spelled two ways is the same home', () => {
  // Only decisive on Windows, where path comparison is case-insensitive; asserted on the
  // resolved-path level so it does not silently become a no-op off Windows.
  const same = checkHomeIsAccountHome({
    runningHome: '/Users/someone/',
    accountHome: '/Users/someone',
  });
  assert.equal(same.real, true, 'a trailing separator is spelling, not a different directory');
});

test('a sandbox nested inside the real home still counts as a sandbox', () => {
  // The obvious place to put a throwaway home is under your own. A prefix comparison would
  // wave this through, which is why the check is equality.
  const nested = checkHomeIsAccountHome({
    runningHome: '/Users/someone/tmp/test-home',
    accountHome: '/Users/someone',
  });
  assert.equal(nested.real, false);
});
