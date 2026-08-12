import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * tests/sync-rules-block.test.js creates a throwaway directory per test and used to remove
 * none of them.
 *
 * Measured on this machine 2026-08-12: one run of that file left 23 directories behind, and
 * C:\Users\Vin\AppData\Local\Temp held 368 of them, the oldest a day old. Every other test
 * file in the repo already cleans up after itself; that one did not, and nothing ever said so
 * — an empty directory breaks nothing, so the only symptom is a temp folder that grows until
 * somebody happens to look.
 *
 * The guard has to live outside the file it measures: a test cannot watch its own cleanup
 * hook, which runs after every test in its file has finished.
 *
 * The measurement works by pointing the child process's temp directory at an empty one of our
 * own. `os.tmpdir()` reads TMPDIR on POSIX and TEMP/TMP on Windows, so setting all three
 * redirects every `mkdtempSync` the child makes, and whatever is left in that directory
 * afterwards is precisely what the child failed to clean up. Nothing in the file under test
 * had to change to be measurable.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const subject = path.join(repoRoot, 'tests', 'sync-rules-block.test.js');

describe('sync-rules-block leaves no temp directories behind', () => {
  it('a full run of the file ends with its temp directory as empty as it started', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-leak-guard-'));
    try {
      assert.deepEqual(fs.readdirSync(scratch), [], 'the scratch directory must start empty');

      // NODE_TEST_CONTEXT and NODE_TEST_WORKER_ID have to go, and this is not tidiness.
      // Node's test runner sets NODE_TEST_CONTEXT=child-v8 in every test process, so a
      // `node --test` spawned from inside a test inherits it and switches from the human
      // reporter to the serialized child protocol — no `pass N` line anywhere in stdout.
      // The first version of this test hit exactly that: the control below fired and
      // reported "could not tell whether the child ran", which is what it is for.
      const env = { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_TEST_WORKER_ID;

      const child = spawnSync(process.execPath, ['--test', subject], {
        encoding: 'utf8',
        cwd: repoRoot,
        env,
      });

      // Positive control, and the reason this test is worth having rather than merely
      // looking like it. A child that never ran — wrong path, a syntax error, a filter that
      // matched nothing — leaves the scratch directory empty too, and the assertion below
      // would pass while measuring nothing at all. So establish that the run happened, and
      // that it was the whole file, before believing what the directory says.
      const ran = child.stdout.match(/^# pass (\d+)$/m) || child.stdout.match(/^ℹ pass (\d+)$/m);
      assert.ok(ran, `could not tell whether the child ran:\n${child.stdout}\n${child.stderr}`);
      assert.ok(Number(ran[1]) >= 20,
        `expected the whole file to run, only ${ran[1]} tests passed — this guard is measuring `
        + 'a run that did not happen');
      assert.equal(child.status, 0, `the subject file must pass on its own:\n${child.stderr}`);

      const left = fs.readdirSync(scratch);
      assert.deepEqual(left, [],
        `${left.length} temp entries survived the run: ${left.slice(0, 5).join(', ')}. `
        + 'Every fixture directory has to be removed by the file that made it — see the '
        + '`after` hook in sync-rules-block.test.js.');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
