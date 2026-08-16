import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The clean-install test is not in the `node --test` default glob - it does an `npm install`
 * and takes minutes, so it lives outside the suite and is named explicitly by a CI job.
 *
 * That arrangement has one failure mode, and it is silent: rename the file, drop the job,
 * or edit the workflow, and nothing goes red. The suite stays green, CI stays green, and the
 * only test that runs the installer stops running. A slow test quietly removed from CI is
 * worse than no test, because the green tick now covers less than it did and says the same
 * thing.
 *
 * So the arrangement is asserted rather than trusted. This file IS in the default glob.
 */

const E2E_FILE = 'tests/install-clean-machine.e2e.mjs';
const WORKFLOW = '.github/workflows/test.yml';

test('the clean-install test exists where CI expects it', () => {
  assert.ok(
    fs.existsSync(path.join(repoRoot, E2E_FILE)),
    `${E2E_FILE} is gone; the only test that runs install.sh is not running`,
  );
});

test('a CI job runs the clean-install test by name', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, WORKFLOW), 'utf8');
  assert.ok(
    workflow.includes(E2E_FILE),
    `${WORKFLOW} no longer names ${E2E_FILE}, so nothing runs it`,
  );
});

test('the clean-install test runs on all three platforms', () => {
  // Windows is the reason this file exists: the install failures reported from real machines
  // were Windows failures, and a clean-install job that only ran on Linux would have been
  // green through every one of them.
  const workflow = fs.readFileSync(path.join(repoRoot, WORKFLOW), 'utf8');
  const job = workflow.slice(workflow.indexOf('\n  install:'));
  assert.ok(job, 'no `install:` job in the workflow');
  for (const os_ of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
    assert.ok(job.includes(os_), `the install job does not run on ${os_}`);
  }
});

test('the file is deliberately outside the default test glob', () => {
  // If it is ever renamed to `.test.js` it joins `npm test`, and every developer and every
  // matrix leg starts paying an npm install for it. That is a decision, not an accident, so
  // it should be made on purpose rather than discovered from a suite that got slow.
  assert.ok(
    !E2E_FILE.endsWith('.test.js'),
    'the clean-install test would now run inside npm test; that is a deliberate choice to make, not a rename',
  );
});
