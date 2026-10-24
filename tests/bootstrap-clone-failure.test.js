import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

/**
 * bootstrap.sh on a machine that has git, when the clone itself fails (a network that blocks
 * GitHub).
 *
 * The clone line ends in `| while read ...`, and the script runs under `set -e` and `pipefail`:
 * a failed clone used to end the whole script right there, before the ERROR and ASK lines that
 * tell the AI what to do could be printed (exit status 128 and nothing else). The re-clone after
 * an old folder was set aside had no check at all, so a person lost the folder's place in the
 * install and heard nothing.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootstrap = path.join(repoRoot, 'scripts', 'bootstrap.sh');
const skip = process.platform === 'win32' ? 'bootstrap.sh is a bash script; Windows has bootstrap.ps1' : false;

/** A git that is not the macOS stub (it lives outside /usr/bin) and whose clone always fails. */
function failingGit() {
  const dir = tempDir('bootstrap-clone-git-');
  const git = path.join(dir, 'git');
  fs.writeFileSync(git, '#!/bin/sh\necho "fatal: unable to access the repository: Could not resolve host" >&2\nexit 128\n', { mode: 0o755 });
  return dir;
}

function run(home, extraEnv = {}) {
  return spawnSync('bash', [bootstrap, 'test-key', 'http://127.0.0.1:9'], {
    encoding: 'utf8',
    cwd: home,
    env: {
      PATH: `${failingGit()}:/usr/bin:/bin`,
      HOME: home,
      OWNMIND_DIR: path.join(home, '.ownmind'),
      ...extraEnv,
    },
  });
}

describe('bootstrap.sh when git is there and the clone fails', () => {
  it('a first install says ERROR and ASK instead of ending silently', { skip }, () => {
    const home = tempDir('bootstrap-clone-home-');
    const r = run(home);
    const said = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 1, said);
    assert.match(said, /ERROR:git_clone:/, said);
    assert.match(said, /ASK:no_network:The installer could not reach the OwnMind server or GitHub\./, said);
    assert.doesNotMatch(said, /OK:done/, said);
  });

  it('a re-clone after the old folder was set aside says so, and names where the old folder went', { skip }, () => {
    const home = tempDir('bootstrap-reclone-home-');
    const dir = path.join(home, '.ownmind');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'leftover.txt'), 'an old, broken install\n');
    const r = run(home);
    const said = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 1, said);
    assert.match(said, /ERROR:git_clone:Re-clone failed; old data preserved at /, said);
    assert.match(said, /ASK:no_network:/, said);
    const kept = fs.readdirSync(home).filter((n) => n.startsWith('.ownmind.broken.'));
    assert.equal(kept.length, 1, `the old folder is kept: ${fs.readdirSync(home)}`);
    assert.ok(fs.existsSync(path.join(home, kept[0], 'leftover.txt')));
  });
});
