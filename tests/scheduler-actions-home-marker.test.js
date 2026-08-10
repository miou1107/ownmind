/**
 * v1.26.133 — the scheduler check failed on every healthy Windows install.
 *
 * safe-spawn.cjs sanitizes the output it returns: `s.split(os.homedir()).join('~')`. That is
 * there so an uploaded self-check report does not carry the user's profile path, and for a
 * report it is right. checkScheduler used the same string for a *comparison*:
 *
 *     const actions = lines.slice(1).join(' ');            // "wscript.exe \"~\\.ownmind\\...\""
 *     if (!taskBelongsToInstall(actions, OWNMIND_DIR))     // OWNMIND_DIR = "C:\Users\Vin\.ownmind"
 *
 * Measured on Windows 2026-08-10. The task was Ready, LastTaskResult 0x0, next run scheduled,
 * and its arguments named this installation's own files:
 *
 *     wscript.exe "C:\Users\Vin\.ownmind\scripts\windows\run-hidden.vbs"
 *                 "C:\Program Files\nodejs\node.exe"
 *                 "C:\Users\Vin\.ownmind\hooks\ownmind-usage-scanner.js"
 *
 * The report said `[FAIL] scheduler  Task Scheduler entry points at another installation`, and
 * advised re-registering — which changes nothing, because nothing is wrong, and the fresh task
 * fails the same comparison tomorrow. Any install directory under the user's home is affected,
 * which is the default for all of them.
 *
 * The PowerShell half of the ownership rule (schedule-health.ps1) reads the actions straight
 * from Get-ScheduledTask and never sees a `~`, so check and repair disagreed again — the same
 * split v1.26.130 was written to close, arriving through the sanitizer this time.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
  .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const { taskBelongsToInstall, expandHomeMarker } = require('../scripts/install-helpers/scheduler-task-owner.cjs');
const { safeSpawn } = require('../scripts/install-helpers/safe-spawn.cjs');

const HOME = String.raw`C:\Users\Vin`;
const OWNMIND_DIR = String.raw`C:\Users\Vin\.ownmind`;
/** Exactly what safeSpawn returned for the measured task. */
const REDACTED = String.raw`wscript.exe "~\.ownmind\scripts\windows\run-hidden.vbs" "C:\Program Files\nodejs\node.exe" "~\.ownmind\hooks\ownmind-usage-scanner.js"`;

describe('expandHomeMarker', () => {
  it('puts the home directory back, so the ownership rule can see it', () => {
    const restored = expandHomeMarker(REDACTED, HOME);
    assert.match(restored, /C:\\Users\\Vin\\\.ownmind\\scripts/);
    assert.equal(taskBelongsToInstall(restored, OWNMIND_DIR), true,
      'the healthy task is still being read as belonging to another installation');
  });

  it('mutation control: without it the healthy task is convicted', () => {
    // The defect, stated as a test. If this ever passes, the sanitizer stopped redacting and
    // the fix has become dead code — which is worth failing over either way.
    assert.equal(taskBelongsToInstall(REDACTED, OWNMIND_DIR), false,
      'the redacted text now matches on its own; re-check why this fix still exists');
  });

  it('expands every occurrence, not only the first', () => {
    // The measured string carries two. Replacing one would leave the second path pointing at
    // a directory that does not exist, which matters the day something parses them.
    const restored = expandHomeMarker(REDACTED, HOME);
    assert.equal(restored.includes('~'), false, `a marker survived: ${restored}`);
  });

  it('leaves a bare tilde alone', () => {
    // `~` only means a home directory when a path separator follows it. A command line may
    // legitimately contain one otherwise, and rewriting that would corrupt the text.
    assert.equal(expandHomeMarker('cmd.exe /c echo ~ done', HOME), 'cmd.exe /c echo ~ done');
  });

  it('a task belonging to somebody else is still not ours after expansion', () => {
    // Reverse control. Expanding must not turn the check into "anything under any home
    // passes" — that false pass is what v1.26.124 was written to remove.
    const adams = String.raw`wscript.exe "C:\Users\Adam\.ownmind\scripts\windows\run-hidden.vbs"`;
    assert.equal(taskBelongsToInstall(expandHomeMarker(adams, HOME), OWNMIND_DIR), false);
  });

  it('is a no-op when there is nothing to work with', () => {
    for (const [text, home] of [['', HOME], ['x', ''], ['x', '   '], [null, HOME], [42, HOME]]) {
      assert.equal(expandHomeMarker(text, home), text);
    }
  });
});

describe('safe-spawn really is the thing that redacts', () => {
  it('stdout comes back with the home directory replaced by a tilde', async () => {
    // The premise of this whole file, asserted against the shipped helper rather than
    // restated. If safeSpawn stops sanitizing, the tests above turn into theatre.
    const r = await safeSpawn(process.execPath, ['-e', 'process.stdout.write(require("os").homedir() + "/.ownmind")'],
      { timeout: 15000 });
    assert.equal(r.ok, true, `the probe did not run: ${r.error}`);
    assert.match(r.stdout, /^~[\\/]\.ownmind$/,
      `safeSpawn no longer redacts the home path: ${JSON.stringify(r.stdout)}`);
  });
});

describe('checkScheduler compares un-redacted text', () => {
  it('the action text is expanded before the ownership question is asked', () => {
    const src = code('scripts/install-helpers/self-check.cjs');
    assert.match(src, /const actions = expandHomeMarker\(/,
      'the scheduler check is comparing safeSpawn output directly again');
    assert.ok(src.indexOf('expandHomeMarker(') < src.indexOf('taskBelongsToInstall(actions'),
      'the expansion must happen before the comparison, or it changes nothing');
  });

  it('the expansion uses the same home the install directory is built from', () => {
    // OWNMIND_DIR is path.join(HOME, '.ownmind'). Expanding against anything else would put
    // the two sides back in different namespaces, which is the defect in a new costume.
    const src = code('scripts/install-helpers/self-check.cjs');
    assert.match(src, /expandHomeMarker\(lines\.slice\(1\)\.join\(' '\), HOME\)/,
      'the expansion and the install directory disagree about what home is');
  });
});
