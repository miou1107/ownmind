import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.30.2 — a suite run must not write into the developer's own check-failure log.
 *
 * Anything that records a failed check appends to `~/.ownmind/logs/check-failures.jsonl`, so
 * an in-process test that drives one to a failure writes there unless it has staged the path
 * first. That file's entire job is answering "when did this start, is it still happening", and
 * fabricated lines carrying real timestamps are the one thing that makes it useless.
 *
 * This is a check rather than a convention because the convention already failed once: the
 * staging was added to `tests/enforcement-compliance-step.test.js` with a comment explaining
 * why, and `tests/hook-notices-i18n.test.js` — which drove the same failures in the same
 * process — did not get it. A comment in one file cannot fail.
 *
 * v1.30.11 — and then the guard itself failed, the same way. It was written around one
 * function name, `runComplianceStep`; the judge moved off the server, the writing moved to
 * `verdict-collect.js`, and the new tests for it put 30 fabricated lines into the real log
 * before anybody noticed. So the list of modules that can write is no longer written down
 * here: it is grown by asking which files import the log. A list somebody has to remember to
 * extend does not fail when they forget.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(repoRoot, 'tests');
const hooksDir = path.join(repoRoot, 'hooks');

/** Every module under hooks/ that can append to the log, found by asking, not by listing. */
function modulesThatWriteTheLog() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/['"][^'"]*check-failure-log\.js['"]/.test(source)) found.push(entry.name);
    }
  };
  walk(hooksDir);
  return found;
}

describe('tests that drive a failed compliance check stage the log path', () => {
  it('finds the modules that write the log rather than being told', () => {
    // If this ever comes back empty the guard below passes vacuously, which is the failure
    // mode a grown list trades for — so the growing is itself checked.
    const writers = modulesThatWriteTheLog();
    assert.ok(writers.length > 0, 'nothing under hooks/ imports check-failure-log.js any more');
    assert.ok(writers.includes('verdict-collect.js'),
      'the module that records why a reply check did not run is no longer found');
  });

  it('every in-process caller of a log-writing module has staged it', () => {
    const writers = modulesThatWriteTheLog();
    const offenders = [];
    for (const name of fs.readdirSync(testsDir)) {
      if (!name.endsWith('.test.js')) continue;
      const source = fs.readFileSync(path.join(testsDir, name), 'utf8');
      // A subprocess-based test gets its own HOME and cannot touch the real file; only
      // in-process callers matter, and those are the ones that import the module.
      const importsAWriter = writers.some((writer) => (
        new RegExp(`from '\\.\\./hooks/(lib/)?${writer.replace('.', '\\.')}'`).test(source)
      ));
      if (!importsAWriter) continue;
      // A CALL with an argument, not a mention. The first version of this guard asked whether
      // the name appeared anywhere, and the import line `{ _logPathForTests }` satisfied that
      // on its own: deleting the staging call left the guard green. Verified by deleting it.
      if (!/_logPathForTests\(\s*[^)\s]/.test(source)) offenders.push(name);
    }
    assert.deepEqual(
      offenders,
      [],
      'these import a module that appends to the check-failure log, in-process, without staging '
      + 'it — so running the suite writes fabricated failures into the real '
      + '~/.ownmind/logs/check-failures.jsonl:\n  '
      + `${offenders.join('\n  ')}\n`
      + "Fix: import { _logPathForTests } from '../hooks/lib/check-failure-log.js' and point it at a tempDir().",
    );
  });
});
