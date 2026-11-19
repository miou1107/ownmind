/**
 * Issue #200, item 3 — git installed after OwnMind.
 *
 * install.sh skips the global `core.hooksPath` on a machine where git is not usable and installs
 * the hook files anyway. Nothing came back to set the path once the owner installed git, so the
 * checks before each commit never ran. scripts/update.sh, which every auto-update runs, now sets
 * it — only while the skip is still pending and only when nobody has set a path since.
 *
 * The block is run on its own, against a stand-in git that keeps its global config in a file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { execBashScript } from './helpers/bash-script.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const updateSh = fs.readFileSync(path.join(root, 'scripts', 'update.sh'), 'utf8');
const installSh = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
const updatePs1 = fs.readFileSync(path.join(root, 'scripts', 'update.ps1'), 'utf8');
const installPs1 = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8');
const skip = process.platform === 'win32' ? 'bash block; the Windows twin is pinned below' : false;

function block(src, name) {
  const begin = src.indexOf(`# BEGIN ${name}`);
  const end = src.indexOf(`# END ${name}`);
  assert.ok(begin >= 0 && end > begin, `${name} markers`);
  return src.slice(begin, end);
}

/**
 * A home with OwnMind's hook files, a stand-in git, and (optionally) a git that is not usable:
 * the macOS stub case, where git sits in the stub directory and xcode-select fails.
 */
function world({ pending = false, release = false, settled = false, preset = '', gitUsable = true } = {}) {
  const home = tempDir('ownmind-late-hooks-');
  const ownmind = path.join(home, '.ownmind');
  const hooks = path.join(ownmind, 'git-hooks');
  fs.mkdirSync(path.join(ownmind, 'scripts', 'install-helpers'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts', 'install-helpers', 'preflight.sh'),
    path.join(ownmind, 'scripts', 'install-helpers', 'preflight.sh'));
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\n');
  if (pending) fs.writeFileSync(path.join(hooks, '.hooks-path-pending'), '');
  if (release) fs.writeFileSync(path.join(ownmind, '.release'), 'v1.33.3\n');
  if (settled) fs.writeFileSync(path.join(hooks, '.hooks-path-settled'), '');

  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const cfg = path.join(home, 'gitconfig-hookspath');
  if (preset) fs.writeFileSync(cfg, preset);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    `CFG='${cfg}'`,
    'if [ "$1 $2 $3 $4" = "config --global --get core.hooksPath" ]; then [ -f "$CFG" ] && cat "$CFG"; exit 0; fi',
    'if [ "$1 $2 $3" = "config --global core.hooksPath" ]; then printf "%s" "$4" > "$CFG"; exit 0; fi',
    'exit 1',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'xcode-select'), `#!/bin/sh\nexit ${gitUsable ? 0 : 2}\n`, { mode: 0o755 });
  return { home, ownmind, hooks, bin, cfg };
}

function run(w) {
  const script = `set -u\nOWNMIND_DIR='${w.ownmind}'\nGIT_HOOK_DIR='${w.hooks}'\n${block(updateSh, 'late-hooks-path')}\n`;
  const out = execBashScript(script, {
    encoding: 'utf8',
    env: {
      PATH: `${w.bin}:/usr/bin:/bin`,
      HOME: w.home,
      OWNMIND_XCODE_SELECT: path.join(w.bin, 'xcode-select'),
      OWNMIND_GIT_STUB_DIR: w.bin,
    },
  });
  const hooksPath = fs.existsSync(w.cfg) ? fs.readFileSync(w.cfg, 'utf8') : '';
  return {
    out, hooksPath,
    pendingLeft: fs.existsSync(path.join(w.hooks, '.hooks-path-pending')),
    settled: fs.existsSync(path.join(w.hooks, '.hooks-path-settled')),
  };
}

describe('issue #200 — the git hooks path is set on a later update once git works', { skip }, () => {
  it('install skipped it, git works now: the path is set and the pending note removed', () => {
    const w = world({ pending: true });
    const r = run(w);
    assert.equal(r.hooksPath, w.hooks);
    assert.equal(r.pendingLeft, false);
    assert.match(r.out, /git is usable now; set git global hooks path/);
  });

  it('a v1.33.3 archive install (no pending note yet) is treated as pending, once', () => {
    const w = world({ release: true });
    const r = run(w);
    assert.equal(r.hooksPath, w.hooks);
    assert.equal(r.settled, true, 'settled after the path is set, so .release stops counting');
  });

  it('an archive install whose owner removed the path after it was settled is left alone', () => {
    // The clone fallback creates archive installs on machines where git works; install.sh sets
    // the path there and writes the settled note. An empty path afterwards is the owner's choice.
    const w = world({ release: true, settled: true });
    assert.equal(run(w).hooksPath, '');
  });

  it('running it twice changes nothing the second time', () => {
    const w = world({ pending: true });
    run(w);
    const second = run(w);
    assert.equal(second.hooksPath, w.hooks);
    assert.equal(second.out.trim(), '', 'nothing to do, nothing printed');
  });

  it('git still not usable: nothing is set and the note stays for the next update', () => {
    const w = world({ pending: true, gitUsable: false });
    const r = run(w);
    assert.equal(r.hooksPath, '');
    assert.equal(r.pendingLeft, true);
  });

  it('a path somebody set since is left alone', () => {
    const w = world({ pending: true, preset: '/somewhere/else' });
    const r = run(w);
    assert.equal(r.hooksPath, '/somewhere/else');
    assert.equal(r.pendingLeft, false, 'nothing is pending once a path is set');
  });

  it('a git checkout install whose owner unset the path is not touched', () => {
    // No pending note and no .release: install.sh set the path, so an empty one now is a choice.
    const w = world();
    assert.equal(run(w).hooksPath, '');
  });
});

describe('issue #200 — the pending note is written where the path is skipped', () => {
  it('install.sh writes it when git is not usable and removes it when the path is set', () => {
    const b = block(installSh, 'global-hooks-path');
    const [usable, notUsable] = b.split('\nelse\n');
    assert.match(usable, /git config --global core\.hooksPath[\s\S]*rm -f "\$HOME\/\.ownmind\/git-hooks\/\.hooks-path-pending"/);
    assert.match(usable, /: > "\$HOME\/\.ownmind\/git-hooks\/\.hooks-path-settled"/);
    assert.match(notUsable, /: > "\$HOME\/\.ownmind\/git-hooks\/\.hooks-path-pending"/);
  });

  it('install.ps1 writes it when sh.exe is missing', () => {
    const at = installPs1.indexOf('Skipping git hooks install');
    assert.ok(at > 0);
    assert.match(installPs1.slice(at, at + 600), /\.hooks-path-pending/);
  });

  it('update.ps1 installs the hooks and sets the path under the same rules', () => {
    const b = block(updatePs1, 'late-hooks-path');
    assert.match(b, /\.hooks-path-pending/);
    assert.match(b, /\.release/);
    assert.match(b, /-and -not \(Test-Path -LiteralPath \$hooksSettledFile\)/);
    assert.match(b, /git config --global --get core\.hooksPath/);
    assert.match(b, /git config --global core\.hooksPath/);
    // The Windows wrappers need sh.exe; without it the hooks would break every commit.
    assert.match(b, /sh\.exe/);
    // Same LF rule as install.ps1: CRLF makes the shebang line unusable under sh.exe.
    assert.match(b, /Replace\("`r`n", "`n"\)/);
  });
});
