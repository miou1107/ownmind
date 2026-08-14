import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.30.2 — a suite run must not write into the developer's own check-failure log.
 *
 * `runComplianceStep` appends a line to `~/.ownmind/logs/check-failures.jsonl` whenever a check
 * fails, so any in-process test that drives it to a failure writes there unless it has staged
 * the path first. That file's entire job is answering "when did this start, is it still
 * happening", and fabricated lines carrying real timestamps are the one thing that makes it
 * useless.
 *
 * This is a check rather than a convention because the convention already failed once: the
 * staging was added to `tests/enforcement-compliance-step.test.js` with a comment explaining
 * why, and `tests/hook-notices-i18n.test.js` — which drives the same failures in the same
 * process — did not get it. A comment in one file cannot fail.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(repoRoot, 'tests');

describe('tests that drive a failed compliance check stage the log path', () => {
  it('every in-process caller of runComplianceStep has staged it', () => {
    const offenders = [];
    for (const name of fs.readdirSync(testsDir)) {
      if (!name.endsWith('.test.js')) continue;
      const source = fs.readFileSync(path.join(testsDir, name), 'utf8');
      // A subprocess-based test gets its own HOME and cannot touch the real file; only
      // in-process callers matter, and those are the ones that import the module.
      const callsInProcess = source.includes('runComplianceStep')
        && /from '\.\.\/hooks\/lib\/compliance-step\.js'/.test(source);
      if (!callsInProcess) continue;
      // A CALL with an argument, not a mention. The first version of this guard asked whether
      // the name appeared anywhere, and the import line `{ _logPathForTests }` satisfied that
      // on its own: deleting the staging call left the guard green. Verified by deleting it.
      if (!/_logPathForTests\(\s*[^)\s]/.test(source)) offenders.push(name);
    }
    assert.deepEqual(
      offenders,
      [],
      'these call runComplianceStep in-process without staging the check-failure log, so running '
      + 'the suite writes fabricated failures into the real ~/.ownmind/logs/check-failures.jsonl:\n  '
      + `${offenders.join('\n  ')}\n`
      + "Fix: import { _logPathForTests } from '../hooks/lib/check-failure-log.js' and point it at a tempDir().",
    );
  });
});
