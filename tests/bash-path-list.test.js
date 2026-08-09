import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toBashPath, toWinPath, bashPathList, makeBashScript } from './helpers/bash-script.js';

/**
 * v1.26.123 — a host path prepended raw to `PATH` is not one entry, it is two.
 *
 * `PATH` separates its entries with a colon, and `C:\Users\…\bin` contains one, so bash
 * reads `C` and `\Users\…\bin`. The second fragment is drive-relative: it points at
 * `\Users\…\bin` *on the current drive*. When the checkout and the temp directory sit on
 * the same drive it happens to name the right directory, which is why the stub `curl` in
 * `hook-log-event-details` was found on a developer machine and not on the CI Windows
 * runner, which checks out onto `D:` while `TEMP` stays on `C:`. The stub was simply never
 * run, and the assertion that the upload branch had fired was correct to fail.
 */

describe('bashPathList', () => {
  it('a Windows path becomes one entry, not two', () => {
    const list = bashPathList('C:\\Users\\Alex\\bin');
    assert.equal(list, '/c/Users/Alex/bin');
    assert.equal(list.split(':').length, 1, 'an entry must not contain the separator');
  });

  it('several entries stay countable', () => {
    const list = bashPathList('C:\\a\\bin', 'D:\\b\\bin', '/usr/bin');
    assert.deepEqual(list.split(':'), ['/c/a/bin', '/d/b/bin', '/usr/bin']);
  });

  it('reverse control: the raw join is what produced the extra entries', () => {
    // Without this, the assertion above passes just as well against a helper that does
    // nothing at all on a POSIX host.
    const raw = ['C:\\a\\bin', 'D:\\b\\bin'].join(':');
    assert.equal(raw.split(':').length, 4, 'two Windows paths joined raw read as four entries');
  });

  it('a POSIX path is returned untouched', () => {
    assert.equal(bashPathList('/usr/local/bin'), '/usr/local/bin');
  });

  it('accepts an array as well as varargs', () => {
    assert.equal(bashPathList(['/a', '/b']), bashPathList('/a', '/b'));
  });
});

/**
 * Pick a drive root that is not the one the temp directory lives on, so a drive-relative
 * fragment cannot resolve by accident. Returns null when the host has only one drive —
 * every POSIX host, and a Windows box with a single volume.
 */
function foreignDriveRoot() {
  if (process.platform !== 'win32') return null;
  const tempDrive = path.parse(os.tmpdir()).root.slice(0, 1).toUpperCase();
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (letter === tempDrive) continue;
    const root = `${letter}:\\`;
    try {
      if (fs.statSync(root).isDirectory()) return root;
    } catch {
      // not mounted — try the next letter
    }
  }
  return null;
}

describe('a stub on PATH shadows the real binary from any drive', () => {
  const foreign = foreignDriveRoot();

  // Nothing to prove where a drive-relative path cannot be wrong. Skipping is stated out
  // loud rather than silently passing, so a green run on a one-drive host is not read as
  // coverage it did not have.
  const skip = foreign === null
    ? 'needs a second drive: a drive-relative fragment can only miss when one exists'
    : false;

  it('found via bashPathList', { skip }, () => {
    const { dir, cleanup } = makeBashScript('true', 'ownmind-shadow-');
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'ownmind-probe'), '#!/bin/bash\necho STUB\n');
      fs.chmodSync(path.join(bin, 'ownmind-probe'), 0o755);

      const run = (pathPrelude) => {
        const s = makeBashScript(`export PATH=${JSON.stringify(pathPrelude)}:$PATH\ncommand -v ownmind-probe || echo MISSING`);
        try {
          return execFileSync('bash', [s.file], { cwd: foreign, encoding: 'utf8' }).trim();
        } finally {
          s.cleanup();
        }
      };

      assert.match(run(bashPathList(bin)), /ownmind-probe$/,
        'the converted entry must resolve from a foreign drive');

      // Reverse control: the raw form is what the runner was actually given. If this ever
      // starts finding the stub too, the test above has stopped proving anything.
      assert.equal(run(bin), 'MISSING',
        'the raw Windows path was invisible from another drive — that was the CI failure');
    } finally {
      cleanup();
    }
  });

  it('reports why it skipped', () => {
    if (skip) assert.ok(typeof skip === 'string' && skip.length > 0);
    else assert.ok(foreign, 'a foreign drive was found and the shadow test ran for real');
  });
});

describe('toWinPath agrees with the shell helper it stands in for', () => {
  // A hand-written twin of `to_win_path` is only useful while it still says the same thing
  // the real one does. This runs the actual function out of path-helpers.sh and compares,
  // so the day cygpath's output shape changes, the twin fails here rather than in whatever
  // test happens to depend on it.
  it('same output for a path a test would hand it', () => {
    const sample = path.join(os.tmpdir(), 'ownmind-x', '.claude', 'settings.json');
    const helper = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', 'scripts', 'install-helpers', 'path-helpers.sh'
    );
    const s = makeBashScript(
      `. ${JSON.stringify(toBashPath(helper))}\nto_win_path ${JSON.stringify(toBashPath(sample))}`
    );
    let fromShell;
    try {
      fromShell = execFileSync('bash', [s.file], { encoding: 'utf8' }).trim();
    } finally {
      s.cleanup();
    }
    assert.equal(toWinPath(sample), fromShell,
      'the JS stand-in and to_win_path must produce the same string');
  });
});

describe('toBashPath', () => {
  it('lowercases the drive letter and flips the separators', () => {
    assert.equal(toBashPath('D:\\a\\b\\c'), '/d/a/b/c');
  });

  it('leaves a path with no drive letter alone', () => {
    assert.equal(toBashPath('/tmp/x'), '/tmp/x');
  });
});
