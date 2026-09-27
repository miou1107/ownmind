import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * #136 — a test may not end itself early on one platform. It has to skip by name.
 *
 * `if (process.platform === 'win32') return;` inside a test body reports a pass on that
 * platform for a test that ran nothing, and the run summary cannot tell it from one that ran
 * and passed. `{ skip: … }` or `t.skip('why')` puts the same decision in the summary with a
 * reason next to it.
 *
 * #136 asked whether a guard should enforce that every test asserts something, and measured
 * that a textual one mostly reports false positives. This is the one narrow shape that is
 * unambiguous in text and recurred: #126 fixed it once, and the sweep for #136 found it again
 * in load-settings-safe and verdict-store. A bare `return;` is what makes it a test body —
 * a helper that answers `return null` on the wrong platform is doing its job.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testsDir = __dirname;

const PLATFORM_RETURN =
  /\bif\s*\(\s*!?\s*(?:process\.platform|os\.platform\(\))\s*[!=]==?\s*['"]\w+['"]\s*\)\s*(?:\{\s*)?return\s*;/;

function testFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

describe('no test passes on a platform by returning early', () => {
  it('every platform exception is a named skip', () => {
    const self = path.basename(fileURLToPath(import.meta.url));
    const offenders = [];
    let scanned = 0;
    for (const file of testFiles(testsDir)) {
      if (path.basename(file) === self) continue;
      scanned += 1;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (PLATFORM_RETURN.test(line)) {
          offenders.push(`${path.relative(testsDir, file).replace(/\\/g, '/')}:${i + 1}`);
        }
      });
    }
    assert.ok(scanned > 100, `only ${scanned} test files found; the walk is looking in the wrong place`);
    assert.deepEqual(offenders, [],
      'these end a test early on one platform, which reports a pass for a test that ran nothing. '
      + "Declare it instead: it('…', { skip: process.platform === 'win32' && 'why' }, …)");
  });

  it('the guard can actually see an offender', () => {
    // Without this the pattern could stop matching and the test above would go green by
    // finding nothing — the silent pass this file exists to forbid.
    for (const sample of [
      "    if (process.platform === 'win32') return; // chmod differs",
      "  if (process.platform !== 'darwin') { return; }",
      "if (os.platform() === 'win32') return;",
    ]) {
      assert.ok(PLATFORM_RETURN.test(sample), `no longer recognised: ${sample}`);
    }
    for (const fine of [
      "  if (process.platform !== 'win32') return null;",
      "it('x', { skip: process.platform === 'win32' && 'no mode bits' }, () => {",
      "  if (process.platform === 'win32') { t.skip('no chmod'); return; }",
    ]) {
      assert.equal(PLATFORM_RETURN.test(fine), false, `flagged a legitimate form: ${fine}`);
    }
  });
});
