import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCleanMac } from './helpers/clean-mac-sim.mjs';
import { spawnBashScript } from './helpers/bash-script.js';

/**
 * install.sh's global git hooks path step, on a Mac whose only git is the /usr/bin/git stub.
 *
 * Found by the zero-touch acceptance run (tests/zero-touch-acceptance.e2e.mjs) on 2026-10-23: the
 * step asked `command -v git`, which finds the stub, then ran `git config --global` twice. On a
 * real Mac each run opens the install-the-developer-tools dialog; the stub exits 1, and under
 * `set -e` the second call aborted the whole install ("install.sh aborted at line 917") after
 * bootstrap had already unpacked the release and installed the private Node. The fix decides with
 * ownmind_git_usable (scripts/install-helpers/preflight.sh), like bootstrap.sh does.
 *
 * The block between the BEGIN/END markers is run on its own, under `set -e`, with the stub git.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installSh = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
const skip = process.platform === 'win32' ? 'install.sh runs under bash on macOS and Linux' : false;

function block() {
  const m = installSh.match(/^# BEGIN global-hooks-path\n([\s\S]*?)^# END global-hooks-path$/m);
  assert.ok(m, 'install.sh must mark the global hooks path step with # BEGIN/END global-hooks-path');
  return m[1];
}

function runBlock(mac, extraEnv = {}) {
  fs.mkdirSync(path.join(mac.home, '.ownmind', 'git-hooks'), { recursive: true });
  const script = `set -e\nset -o pipefail\nOWNMIND_DIR="${repoRoot}"\n${block()}\necho BLOCK_DONE\n`;
  return spawnBashScript(script, { env: { ...mac.env, ...extraEnv }, encoding: 'utf8' });
}

test('with only the macOS git stub, the hooks path step skips git and the install goes on', { skip }, () => {
  const mac = makeCleanMac({ xcodeStub: true });
  try {
    const r = runBlock(mac);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /BLOCK_DONE/);
    assert.match(r.stdout, /\[WARN\] git not found, skipping global hooks path/);
    assert.ok(!fs.existsSync(mac.gitMarker), 'the git stub was executed; on a real Mac that opens the developer-tools dialog');
    assert.doesNotMatch(r.stderr, /requesting install/);
  } finally {
    mac.cleanup();
  }
});

test('with a real git (the developer tools installed), the hooks path is still set', { skip }, () => {
  const mac = makeCleanMac({ xcodeStub: true });
  try {
    // A git that records its arguments and succeeds, in the stub directory, with xcode-select
    // reporting the developer tools as present: ownmind_git_usable must call that a real git.
    const calls = path.join(mac.home, 'git-calls');
    fs.writeFileSync(path.join(mac.binDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nexit 0\n`, { mode: 0o755 });
    const r = runBlock(mac, { OWNMIND_XCODE_SELECT: '/usr/bin/true' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[ OK \] Set git global hooks path:/);
    assert.match(fs.readFileSync(calls, 'utf8'), /^config --global core\.hooksPath .*\.ownmind\/git-hooks$/m);
  } finally {
    mac.cleanup();
  }
});
