/**
 * OwnMind sets core.hooksPath globally, and from then on git stops looking in each
 * repository's .git/hooks. OwnMind installed only pre-commit, commit-msg, post-commit and
 * pre-merge-commit there, so every other hook a repository had was skipped without a word —
 * Git LFS's pre-push among them: `git push` reported success and the large files never went
 * up. A global hooks path somebody had before OwnMind was overwritten and forgotten too.
 *
 * These tests drive real git: a repository with its own hooks, a hooks directory holding the
 * pass-through, and a push to a local bare repository.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const PASSTHROUGH = read('hooks/ownmind-git-passthrough').replace(/\r/g, '');

const git = (cwd, args, extra = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', ...extra });
const posix = (p) => p.replace(/\\/g, '/');

function writeHook(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body.replace(/\r/g, ''));
  fs.chmodSync(p, 0o755);
  return p;
}

/** A repository with one commit, a bare remote, and a hooks dir holding the pass-through. */
function setup() {
  const root = tempDir('ownmind-hooks-');
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  const hooks = path.join(root, 'ownmind-git-hooks');
  git(root, ['init', '-q', '--bare', remote]);
  git(root, ['init', '-q', repo]);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false']]) {
    git(repo, ['config', k, v]);
  }
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['-c', 'core.hooksPath=/nonexistent-ownmind-test', 'commit', '-q', '-m', 'one']);
  git(repo, ['remote', 'add', 'origin', remote]);
  for (const name of ['pre-push', 'post-checkout', 'post-merge']) writeHook(hooks, name, PASSTHROUGH);
  return { root, remote, repo, hooks };
}

const push = (s) => git(s.repo, ['-c', `core.hooksPath=${posix(s.hooks)}`, 'push', '-q', 'origin', 'HEAD:refs/heads/main']);

let gitWorks = false;
before(() => { gitWorks = git(process.cwd(), ['--version']).status === 0; });

describe('the defect, measured: without the pass-through a repository\'s pre-push never runs', () => {
  it('a global hooks path with no pre-push file silently skips the repository\'s pre-push', (t) => {
    if (!gitWorks) return t.skip('git is not available');
    const s = setup();
    fs.rmSync(path.join(s.hooks, 'pre-push'));
    const marker = path.join(s.root, 'pre-push-ran.txt');
    writeHook(path.join(s.repo, '.git', 'hooks'), 'pre-push', `#!/bin/sh\necho ran > '${posix(marker)}'\n`);
    const r = push(s);
    assert.equal(r.status, 0, 'git reports success…');
    assert.equal(fs.existsSync(marker), false, '…and the repository\'s pre-push (Git LFS) never ran');
  });
});

describe('the pass-through hands git\'s call to the repository\'s own hook', () => {
  it('a repository\'s pre-push runs again on push — with its arguments and the refs on stdin (Git LFS)', (t) => {
    if (!gitWorks) return t.skip('git is not available');
    const s = setup();
    const marker = path.join(s.root, 'pre-push-ran.txt');
    writeHook(path.join(s.repo, '.git', 'hooks'), 'pre-push',
      `#!/bin/sh\nprintf 'args:%s %s\\n' "$1" "$2" > '${posix(marker)}'\ncat >> '${posix(marker)}'\n`);
    const r = push(s);
    assert.equal(r.status, 0, r.stderr);
    const got = fs.readFileSync(marker, 'utf8');
    assert.match(got, /^args:origin /, got);
    assert.match(got, /refs\/heads\/main/, 'the refs being pushed reach the hook on stdin');
  });

  it('a repository hook that refuses still stops the push', (t) => {
    if (!gitWorks) return t.skip('git is not available');
    const s = setup();
    writeHook(path.join(s.repo, '.git', 'hooks'), 'pre-push', '#!/bin/sh\necho refused >&2\nexit 1\n');
    const r = push(s);
    assert.notEqual(r.status, 0);
    assert.equal(git(s.remote, ['rev-parse', '--verify', '-q', 'refs/heads/main']).status, 1, 'nothing reached the remote');
  });

  it('a repository without its own hook pushes as before', (t) => {
    if (!gitWorks) return t.skip('git is not available');
    const s = setup();
    assert.equal(push(s).status, 0);
  });

  it('post-checkout reaches the repository\'s hook too', (t) => {
    if (!gitWorks) return t.skip('git is not available');
    const s = setup();
    const marker = path.join(s.root, 'post-checkout-ran.txt');
    writeHook(path.join(s.repo, '.git', 'hooks'), 'post-checkout', `#!/bin/sh\necho ran > '${posix(marker)}'\n`);
    const r = git(s.repo, ['-c', `core.hooksPath=${posix(s.hooks)}`, 'checkout', '-q', '-b', 'side']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(marker));
  });
});

describe('a global hooks path from before OwnMind is handed on, not forgotten', () => {
  it('the previous path\'s hook runs first, then the repository\'s', (t) => {
    if (!gitWorks) return t.skip('git is not available');
    const s = setup();
    const order = path.join(s.root, 'order.txt');
    const previous = path.join(s.root, 'my-old-global-hooks');
    writeHook(previous, 'pre-push', `#!/bin/sh\necho previous >> '${posix(order)}'\ncat > /dev/null\n`);
    writeHook(path.join(s.repo, '.git', 'hooks'), 'pre-push', `#!/bin/sh\necho repo >> '${posix(order)}'\ncat > /dev/null\n`);
    fs.writeFileSync(path.join(s.hooks, '.previous-hooks-path'), posix(previous) + '\n');
    assert.equal(push(s).status, 0);
    assert.deepEqual(fs.readFileSync(order, 'utf8').trim().split(/\s+/), ['previous', 'repo']);
  });

  it('a previous path that points back at OwnMind\'s own directory does not loop', (t) => {
    if (!gitWorks) return t.skip('git is not available');
    const s = setup();
    fs.writeFileSync(path.join(s.hooks, '.previous-hooks-path'), posix(s.hooks) + '\n');
    const r = spawnSync('git', ['-c', `core.hooksPath=${posix(s.hooks)}`, 'push', '-q', 'origin', 'HEAD:refs/heads/main'],
      { cwd: s.repo, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr || String(r.error));
  });

  it('OwnMind\'s own pre-commit hands on to the previous path as well', (t) => {
    if (!gitWorks) return t.skip('git is not available');
    const s = setup();
    // OwnMind's wrapper runs $HOME/.ownmind/hooks/ownmind-git-pre-commit.js first.
    const home = path.join(s.root, 'home');
    fs.mkdirSync(path.join(home, '.ownmind', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ownmind', 'hooks', 'ownmind-git-pre-commit.js'), 'process.exit(0);\n');
    writeHook(s.hooks, 'pre-commit', read('hooks/ownmind-git-pre-commit'));
    const previous = path.join(s.root, 'old-hooks');
    const marker = path.join(s.root, 'old-pre-commit-ran.txt');
    writeHook(previous, 'pre-commit', `#!/bin/sh\necho ran > '${posix(marker)}'\n`);
    fs.writeFileSync(path.join(s.hooks, '.previous-hooks-path'), posix(previous) + '\n');
    fs.writeFileSync(path.join(s.repo, 'b.txt'), 'b\n');
    git(s.repo, ['add', 'b.txt']);
    const r = git(s.repo, ['-c', `core.hooksPath=${posix(s.hooks)}`, 'commit', '-q', '-m', 'two'],
      { env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(marker), 'the hook from the previous global path ran');
  });
});

describe('installers and updaters agree', () => {
  const lists = {
    'install.sh': read('install.sh').match(/OWNMIND_PASSTHROUGH_HOOKS="([^"]+)"/)?.[1].split(/\s+/),
    'scripts/update.sh': read('scripts/update.sh').match(/for pt_name in ([^;]+);/)?.[1].trim().split(/\s+/),
    'install.ps1': [...(read('install.ps1').match(/foreach \(\$ptName in @\(([^)]+)\)\)/)?.[1] || '').matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    'scripts/update.ps1': [...(read('scripts/update.ps1').match(/foreach \(\$ptName in @\(([^)]+)\)\)/)?.[1] || '').matchAll(/"([^"]+)"/g)].map((m) => m[1]),
  };

  it('all four install the same pass-through list, with pre-push in it', () => {
    for (const [file, list] of Object.entries(lists)) {
      assert.ok(list && list.length > 0, `${file}: list not found`);
      assert.deepEqual(list, lists['install.sh'], `${file} differs from install.sh`);
    }
    assert.ok(lists['install.sh'].includes('pre-push'));
  });

  it('the list is exactly what Git LFS needs beyond post-commit — and nothing that fires on every commit', () => {
    // Each hook costs a shell start per git command that fires it (about 0.1 s on Windows),
    // so the list was kept to push, checkout and merge (Vin, 2026-10-03).
    assert.deepEqual(lists['install.sh'], ['pre-push', 'post-checkout', 'post-merge']);
  });

  it('both installers record a previous global hooks path once, and never OwnMind\'s own directory', () => {
    const sh = read('install.sh');
    assert.match(sh, /git config --global --get core\.hooksPath \|\| true/);
    assert.match(sh, /\[ ! -f "\$HOME\/\.ownmind\/git-hooks\/\.previous-hooks-path" \]/);
    assert.match(sh, /\.ownmind\/git-hooks\) previous_is_ours=yes/);
    const ps = read('install.ps1');
    assert.match(ps, /git config --global --get core\.hooksPath/);
    assert.match(ps, /-not \(Test-Path \$previousRecord\)/);
    assert.match(ps, /\\\.ownmind\/git-hooks\$/);
  });

  it('updaters create the pass-throughs only where OwnMind\'s pre-commit is already installed', () => {
    assert.match(read('scripts/update.sh'), /if \[ -f "\$GIT_HOOK_DIR\/pre-commit" \] && \[ -f "\$PASSTHROUGH_SRC" \]/);
    assert.match(read('scripts/update.ps1'), /Test-Path \(Join-Path \$GitHookDir "pre-commit"\)\) -and \(Test-Path \$passthroughSrc\)/);
  });
});

describe('the right repository\'s hook, wherever git runs it from', () => {
  it('in a linked worktree, the main repository\'s pre-push runs (a worktree has no hooks of its own)', (t) => {
    if (!gitWorks) return t.skip('git is not available');
    const s = setup();
    const marker = path.join(s.root, 'worktree-pre-push.txt');
    writeHook(path.join(s.repo, '.git', 'hooks'), 'pre-push', `#!/bin/sh\necho ran > '${posix(marker)}'\ncat > /dev/null\n`);
    const wt = path.join(s.root, 'wt');
    assert.equal(git(s.repo, ['-c', 'core.hooksPath=/nonexistent-ownmind-test', 'worktree', 'add', '-q', '-b', 'wtb', wt]).status, 0);
    const r = git(wt, ['-c', `core.hooksPath=${posix(s.hooks)}`, 'push', '-q', 'origin', 'HEAD:refs/heads/wtb']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(marker), 'the main repository\'s pre-push ran from the worktree');
  });

  it('OwnMind\'s pre-commit in a linked worktree chains the main repository\'s hook too', (t) => {
    if (!gitWorks) return t.skip('git is not available');
    const s = setup();
    const home = path.join(s.root, 'home');
    fs.mkdirSync(path.join(home, '.ownmind', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ownmind', 'hooks', 'ownmind-git-pre-commit.js'), 'process.exit(0);\n');
    writeHook(s.hooks, 'pre-commit', read('hooks/ownmind-git-pre-commit'));
    const marker = path.join(s.root, 'wt-pre-commit.txt');
    writeHook(path.join(s.repo, '.git', 'hooks'), 'pre-commit', `#!/bin/sh\necho ran > '${posix(marker)}'\n`);
    const wt = path.join(s.root, 'wt2');
    git(s.repo, ['-c', 'core.hooksPath=/nonexistent-ownmind-test', 'worktree', 'add', '-q', '-b', 'wtc', wt]);
    fs.writeFileSync(path.join(wt, 'c.txt'), 'c\n');
    git(wt, ['add', 'c.txt']);
    const r = git(wt, ['-c', `core.hooksPath=${posix(s.hooks)}`, 'commit', '-q', '-m', 'wt'],
      { env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(marker));
  });

  it('when git is told which repository to use, a different .git in the current folder is not consulted', (t) => {
    if (!gitWorks) return t.skip('git is not available');
    const s = setup();
    const wrong = path.join(s.root, 'wrong.txt');
    // The folder git runs in holds an unrelated repository with its own post-checkout...
    const decoy = path.join(s.root, 'decoy');
    git(s.root, ['init', '-q', decoy]);
    writeHook(path.join(decoy, '.git', 'hooks'), 'post-checkout', `#!/bin/sh\necho wrong > '${posix(wrong)}'\n`);
    // ...while the command names the real one explicitly.
    const r = spawnSync('git', ['--git-dir', posix(path.join(s.repo, '.git')), '--work-tree', posix(s.repo),
      '-c', `core.hooksPath=${posix(s.hooks)}`, 'checkout', '-q', '-b', 'named'], { cwd: decoy, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(wrong), false, 'the decoy repository\'s hook must not run');
  });
});

describe('Git LFS without hooks of its own', () => {
  it('a repository that tracks files with LFS but has no pre-push gets what LFS\'s hook would run', (t) => {
    if (!gitWorks) return t.skip('git is not available');
    const s = setup();
    // A stand-in for git-lfs on PATH: `git lfs pre-push ...` runs it as git-lfs.
    const bin = path.join(s.root, 'bin');
    const marker = path.join(s.root, 'lfs-called.txt');
    writeHook(bin, 'git-lfs', `#!/bin/sh\nprintf '%s\\n' "$*" > '${posix(marker)}'\ncat >> '${posix(marker)}'\n`);
    fs.writeFileSync(path.join(s.repo, '.gitattributes'), '*.psd filter=lfs diff=lfs merge=lfs -text\n');
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    // Git for Windows ships its own git-lfs and finds it ahead of PATH, so the stand-in
    // never runs there. The real one doing the job is not something this test can observe.
    if (/git-lfs\//.test(git(s.repo, ['lfs', 'version'], { env }).stdout || '')) {
      return t.skip('a git-lfs bundled with git shadows the stand-in');
    }
    fs.rmSync(marker, { force: true });
    const r = git(s.repo, ['-c', `core.hooksPath=${posix(s.hooks)}`, 'push', '-q', 'origin', 'HEAD:refs/heads/main'], { env });
    assert.equal(r.status, 0, r.stderr);
    const got = fs.readFileSync(marker, 'utf8');
    assert.match(got, /^pre-push origin /, got);
    assert.match(got, /refs\/heads\/main/, 'LFS gets the refs on stdin, as from its own hook');
  });

  it('a repository without LFS attributes does not call git-lfs', (t) => {
    if (!gitWorks) return t.skip('git is not available');
    const s = setup();
    const bin = path.join(s.root, 'bin');
    const marker = path.join(s.root, 'lfs-called.txt');
    writeHook(bin, 'git-lfs', `#!/bin/sh\necho called > '${posix(marker)}'\n`);
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    assert.equal(git(s.repo, ['-c', `core.hooksPath=${posix(s.hooks)}`, 'push', '-q', 'origin', 'HEAD:refs/heads/main'], { env }).status, 0);
    assert.equal(fs.existsSync(marker), false);
  });
});

describe('a hook in ~/.ownmind/git-hooks that is not OwnMind\'s is never overwritten', () => {
  it('the pass-through carries the marker the installers look for', () => {
    assert.match(PASSTHROUGH, /OWNMIND-PASSTHROUGH-HOOK/);
  });

  it('all four installers and updaters check for it before writing', () => {
    assert.match(read('install.sh'), /grep -q 'OWNMIND-PASSTHROUGH-HOOK' "\$passthrough_dst"/);
    assert.match(read('scripts/update.sh'), /grep -q 'OWNMIND-PASSTHROUGH-HOOK' "\$pt"/);
    assert.match(read('install.ps1'), /Contains\("OWNMIND-PASSTHROUGH-HOOK"\)/);
    assert.match(read('scripts/update.ps1'), /Contains\("OWNMIND-PASSTHROUGH-HOOK"\)/);
  });

  it('update.sh leaves a user\'s own pre-push (as git lfs install writes it) exactly as it was', (t) => {
    if (spawnSync('bash', ['--version']).status !== 0) return t.skip('bash is not available');
    const root = tempDir('ownmind-upd-');
    const hookDir = path.join(root, 'git-hooks');
    fs.mkdirSync(hookDir);
    fs.writeFileSync(path.join(hookDir, 'pre-commit'), '#!/bin/sh\n');
    const lfsHook = '#!/bin/sh\ngit lfs pre-push "$@"\n';
    fs.writeFileSync(path.join(hookDir, 'pre-push'), lfsHook);
    // Run only the pass-through block of update.sh, with its variables pointed at the temp dir.
    const src = read('scripts/update.sh');
    const start = src.indexOf('  PASSTHROUGH_SRC="$OWNMIND_DIR/hooks/ownmind-git-passthrough"');
    const end = src.indexOf('# --- 2b. Sync usage scanner');
    assert.ok(start > 0 && end > start, 'pass-through block not found in update.sh');
    const block = src.slice(start, end).replace(/\nfi\s*$/, '\n');
    const scriptFile = path.join(root, 'block.sh');
    fs.writeFileSync(scriptFile, `GIT_HOOK_DIR='${posix(hookDir)}'\nOWNMIND_DIR='${posix(repoRoot)}'\n${block}`);
    const r = spawnSync('bash', [posix(scriptFile)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(hookDir, 'pre-push'), 'utf8'), lfsHook, 'the user\'s own hook is untouched');
    assert.match(fs.readFileSync(path.join(hookDir, 'post-checkout'), 'utf8'), /OWNMIND-PASSTHROUGH-HOOK/, 'free names still get the pass-through');
  });
});
