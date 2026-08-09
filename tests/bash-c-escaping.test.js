import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toBashPath } from './helpers/bash-script.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(repoRoot, 'tests');

/**
 * v1.26.109 — a test that builds a shell script in JS and hands it to `bash -c` runs a
 * different script on Windows than it does on macOS.
 *
 * node quotes the argument by MSVCRT rules; `bash.exe` from Git Bash parses the command
 * line by MSYS rules; they disagree about a backslash immediately before a quote. The real
 * line out of hooks/ownmind-session-start.sh, measured:
 *
 *     sed 's/\\/\\\\/g; s/"/\\"/g'      <- what the file says
 *     bash -c <string> -> ""            <- sed: unknown option to `s'
 *     bash <file>      -> "pull"
 *
 * The damage is quiet: sed fails, the value comes out empty, and the assertion reports a
 * wrong value rather than a quoting error. `hook-log-event-details` claimed the hook wrote
 * `{ step: '' }` when the hook writes `{ step: 'pull' }` correctly on every platform.
 *
 * Both cases here run anywhere. The mangling is a property of how the string crosses the
 * process boundary, and the rule about which form to use can be read off the source.
 */

// Files still on `bash -c`, each of them red on Windows today. This list may shrink and must
// never grow: a new entry means a new test written the way that hid a defect for eleven
// releases. The second case below deletes stale entries by failing on them, so the list
// cannot quietly outlive the debt it records.
const NOT_YET_CONVERTED = new Set([
  'dep-floor-guard.test.js',
  'install-failed-beacon.test.js',
  'installer-node-paths.test.js',
  'shebang-eol.test.js',
  'sweep-old-backups.test.js',
  'update-lock-mutual-exclusion.test.js',
  'upgrade-complete-beacon.test.js',
  'upgrade-error-reason.test.js',
  'upgrade-rollback-honesty.test.js',
]);

const BASH_C = /\bbash['"]\s*,\s*\[\s*['"]-c['"]/;

function testFilesUsingBashC() {
  return fs.readdirSync(testsDir)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => BASH_C.test(fs.readFileSync(path.join(testsDir, f), 'utf8')));
}

describe('v1.26.109 — bash -c loses backslashes on Windows', () => {
  it('no new test hands a generated script to bash -c', () => {
    const offenders = testFilesUsingBashC().filter((f) => !NOT_YET_CONVERTED.has(f));
    assert.deepEqual(
      offenders, [],
      'use execBashScript / spawnBashScript from tests/helpers/bash-script.js — they deliver '
        + 'the script as a file, which has no command line to be re-parsed:\n  '
        + offenders.join('\n  '),
    );
  });

  it('the not-yet-converted list contains nothing that has already been converted', () => {
    const stillUsing = new Set(testFilesUsingBashC());
    const stale = [...NOT_YET_CONVERTED].filter((f) => !stillUsing.has(f));
    assert.deepEqual(
      stale, [],
      `these no longer use bash -c; drop them from NOT_YET_CONVERTED:\n  ${stale.join('\n  ')}`,
    );
  });

  it('a script delivered as a file survives; the same script through -c may not', () => {
    // The measurement itself, kept as a case so the claim above is checkable rather than
    // remembered. Only the file form is asserted: `bash -c` is correct on macOS and Linux,
    // and asserting it breaks would make this fail everywhere except the platform it is
    // about — the same mistake in the other direction.
    const sed = "sed 's/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g'";
    const script = `printf '%s' 'pull' | ${sed}\n`;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-bashc-'));
    try {
      const file = path.join(dir, 's.sh');
      fs.writeFileSync(file, script);
      const viaFile = spawnSync('bash', [file], { encoding: 'utf8' });
      assert.equal(viaFile.status, 0, `bash failed: ${viaFile.stderr}`);
      assert.equal(viaFile.stdout, 'pull', 'the file form must deliver the script unchanged');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no test names an interpreter by absolute POSIX path', () => {
    // v1.26.110 — `spawn('/bin/bash', …)` is resolved by node through Win32 rules, where
    // /bin/bash is not a file, so every case in run-scanner-wrapper died with ENOENT before
    // the script under test ran. `bash` is found from PATH on all three platforms.
    //
    // Executing a shell script directly is the same mistake with the interpreter left
    // implicit: `#!` is a kernel feature and Windows has none, so CreateProcess is handed a
    // text file. That one cannot be checked from the source alone — the path is usually a
    // variable — so it is written down here rather than pretended to be guarded.
    const offenders = [];
    for (const f of fs.readdirSync(testsDir).filter((n) => n.endsWith('.test.js'))) {
      const src = fs.readFileSync(path.join(testsDir, f), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        // Only the first argument of a spawn, which is the one node has to resolve. The same
        // string as an expected value or a stub's return is data about the platform under
        // test, not a process this suite is trying to start.
        if (/(?:spawnSync|spawn|execFileSync|execFile)\(\s*['"]\/(?:usr\/)?bin\/(?:bash|sh|env)['"]/.test(line)) {
          offenders.push(`${f}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      offenders, [],
      `name the interpreter without a path — 'bash', not '/bin/bash':\n  ${offenders.join('\n  ')}`,
    );
  });

  it('toBashPath leaves a POSIX path alone and converts a Windows one', () => {
    assert.equal(toBashPath('/tmp/x/y'), '/tmp/x/y');
    assert.equal(toBashPath('C:\\Users\\Vin\\Temp'), '/c/Users/Vin/Temp');
    assert.equal(toBashPath('D:/data'), '/d/data');
  });
});
