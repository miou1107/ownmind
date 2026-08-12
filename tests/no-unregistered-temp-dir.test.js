import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

/**
 * A test may not draw its own temp directory, because nothing then says whether it removes it.
 *
 * v1.26.153 fixed one file that leaked, and its own tasks note said auditing the rest was out
 * of scope. The audit, run 2026-08-13: 5264 leftover directories in the system temp folder
 * across eleven prefixes, oldest six days old, from files written long after the first leak
 * was understood. The failure mode is that there is no failure — an empty directory breaks
 * nothing, so a leaking test is indistinguishable from a clean one until somebody counts.
 *
 * So the rule is not "clean up after yourself", which is unenforceable, but "there is one way
 * to get scratch space and it cleans up for you". This guard is the half with teeth: it makes
 * opting out impossible to do quietly.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const testsDir = path.join(repoRoot, 'tests');
const helper = path.join(testsDir, 'helpers', 'temp-dir.js');

// The helper draws the directory it hands out, and the guard below has to draw one before the
// helper exists in the child process it builds. Both are named, so removing an exemption is a
// decision somebody makes rather than a regex that quietly widens.
const EXEMPT = new Set([
  'helpers/temp-dir.js',
  'no-unregistered-temp-dir.test.js',
  'sync-rules-block-no-temp-leak.test.js',
]);

const RAW = /mkdtemp(?:Sync)?\(\s*(?:[\w$]+\.)?join\(\s*(?:[\w$]+\.)?tmpdir\(\)/;

function testFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('no test draws a temp directory nobody removes', () => {
  it('every file under tests/ goes through the shared helper', () => {
    const offenders = [];
    for (const file of testFiles(testsDir)) {
      const rel = path.relative(testsDir, file).replace(/\\/g, '/');
      if (EXEMPT.has(rel)) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (RAW.test(src)) offenders.push(rel);
    }

    assert.deepEqual(offenders, [],
      `${offenders.length} file(s) create a temp directory directly: ${offenders.join(', ')}. `
      + "Use `tempDir('prefix-')` from tests/helpers/temp-dir.js — it removes what it made when "
      + 'the file finishes. A directory drawn by hand is one nobody is accountable for.');
  });

  it('the guard can actually see an offender', () => {
    // Without this the regex could stop matching after a refactor and the test above would go
    // green by matching nothing at all — the same silent pass this whole change is about.
    const sample = "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));";
    assert.ok(RAW.test(sample), 'the pattern no longer recognises the thing it forbids');
    assert.equal(RAW.test("const d = tempDir('x-');"), false);
  });

  it('the helper removes what it handed out', () => {
    // The static rule is only worth anything if the one permitted route really cleans up, and
    // a file cannot watch its own cleanup hook — that hook runs after its last test. So the
    // measurement happens in a child process with its temp directory pointed somewhere empty:
    // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows, so whatever survives in there
    // is exactly what the helper failed to remove.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-helper-guard-'));
    try {
      const probe = path.join(scratch, 'probe.test.mjs');
      fs.writeFileSync(probe, [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import fs from 'node:fs';",
        `import { tempDir } from ${JSON.stringify(pathToFileURL(helper).href)};`,
        "test('draws two directories', () => {",
        "  assert.ok(fs.existsSync(tempDir('probe-a-')));",
        "  assert.ok(fs.existsSync(tempDir('probe-b-')));",
        '});',
        '',
      ].join('\n'));

      const env = { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch };
      // Inherited from the runner, these switch the child to the serialized child-process
      // reporter and there is no `pass N` line left to read.
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_TEST_WORKER_ID;

      const child = spawnSync(process.execPath, ['--test', probe], {
        encoding: 'utf8', cwd: repoRoot, env,
      });

      const ran = child.stdout.match(/^[#ℹ] pass (\d+)$/m);
      assert.ok(ran, `could not tell whether the child ran:\n${child.stdout}\n${child.stderr}`);
      assert.equal(ran[1], '1', 'the probe did not run, so nothing was measured');
      assert.equal(child.status, 0, `probe failed:\n${child.stderr}`);

      const left = fs.readdirSync(scratch).filter((n) => n !== 'probe.test.mjs');
      assert.deepEqual(left, [],
        `the helper left ${left.length} directory(ies) behind: ${left.join(', ')}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
