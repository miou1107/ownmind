/**
 * Automatic updates moved every machine to the tip of GitHub's main branch, so anything that
 * landed there (a commit between a fix and its release, a push made by mistake) was on every
 * machine by the next session. They now go to the newest release tag on main.
 *
 * Real git throughout: a bare "GitHub", a checkout standing in for ~/.ownmind. Only npm and
 * the sync script are stubbed.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const { runAutoUpdate, APPLIED, CLEAN } = await import('../shared/auto-update.js');
const { sortReleaseTags } = await import('../shared/release-target.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realExec = promisify(execFileCb);
const gitWorks = spawnSync('git', ['--version']).status === 0;
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'tag.gpgSign=false', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let s;
beforeEach(() => {
  if (!gitWorks) return;
  const base = tempDir('ownmind-reltag-');
  const remote = path.join(base, 'remote.git');
  const dev = path.join(base, 'dev');
  const machine = path.join(base, '.ownmind');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(base, 'clone', '-q', remote, dev);
  const commit = (msg) => {
    fs.writeFileSync(path.join(dev, 'f.txt'), msg);
    git(dev, 'add', '.');
    git(dev, 'commit', '-q', '-m', msg);
    return git(dev, 'rev-parse', 'HEAD');
  };
  const first = commit('one');
  git(dev, 'tag', 'v1.0.0');
  git(dev, 'push', '-q', 'origin', 'main', 'v1.0.0');
  git(base, 'clone', '-q', remote, machine);
  fs.mkdirSync(path.join(machine, 'mcp'));
  s = { base, remote, dev, machine, commit, first };
});

/** Real git; npm and the sync script recorded and skipped. */
function exec() {
  const ran = [];
  const execFile = async (cmd, args = [], opts = {}) => {
    ran.push([cmd, ...args].join(' '));
    if (cmd === 'git') return realExec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { ...opts, env: ENV });
    return { stdout: '', stderr: '' };
  };
  return { ran, execFile };
}

function opts(execFile) {
  return {
    ownmindDir: s.machine,
    markerFile: path.join(s.base, 'marker'),
    lockFile: path.join(s.base, 'lock'),
    source: 'scanner',
    execFile,
    today: () => '2026-10-03',
    execPath: path.join(s.base, 'no-npm', 'node'),
  };
}

describe('the automatic update goes to the newest release, not to main', () => {
  it('does not move to a commit on main that no release tag points at', { skip: !gitWorks && 'no git' }, async () => {
    s.commit('two, not released');
    git(s.dev, 'push', '-q', 'origin', 'main');
    const { execFile } = exec();
    const out = await runAutoUpdate(opts(execFile));
    assert.equal(out.outcome, CLEAN);
    assert.equal(git(s.machine, 'rev-parse', 'HEAD'), s.first, 'stays on v1.0.0');
  });

  it('moves to a new release tag, and no further', { skip: !gitWorks && 'no git' }, async () => {
    const released = s.commit('two');
    git(s.dev, 'tag', 'v1.0.1');
    s.commit('three, not released');
    git(s.dev, 'push', '-q', 'origin', 'main', 'v1.0.1');
    const { execFile, ran } = exec();
    const out = await runAutoUpdate(opts(execFile));
    assert.equal(out.outcome, APPLIED, ran.join('\n'));
    assert.equal(git(s.machine, 'rev-parse', 'HEAD'), released);
  });

  it('ignores a release tag that is not on main', { skip: !gitWorks && 'no git' }, async () => {
    git(s.dev, 'checkout', '-q', '-b', 'side');
    s.commit('side work');
    git(s.dev, 'tag', 'v9.9.9');
    git(s.dev, 'push', '-q', 'origin', 'side', 'v9.9.9');
    const { execFile } = exec();
    const out = await runAutoUpdate(opts(execFile));
    assert.equal(out.outcome, CLEAN);
    assert.equal(git(s.machine, 'rev-parse', 'HEAD'), s.first);
  });

  it('a machine already ahead of the newest release stays where it is', { skip: !gitWorks && 'no git' }, async () => {
    const ahead = s.commit('two, not released');
    git(s.dev, 'push', '-q', 'origin', 'main');
    git(s.machine, 'pull', '-q', '--ff-only');
    const { execFile } = exec();
    const out = await runAutoUpdate(opts(execFile));
    assert.equal(out.outcome, CLEAN);
    assert.equal(git(s.machine, 'rev-parse', 'HEAD'), ahead, 'never moved backwards');
  });

  it('a tag moved on GitHub does not stop every later update', { skip: !gitWorks && 'no git' }, async () => {
    // Review finding: with a plain `fetch --tags`, a re-created tag fails the fetch with
    // "would clobber existing tag" on every run, on every machine, for good.
    const a = s.commit('two');
    git(s.dev, 'tag', 'v1.0.1');
    git(s.dev, 'push', '-q', 'origin', 'main', 'v1.0.1');
    git(s.machine, 'fetch', '-q', '--tags');
    git(s.machine, 'reset', '-q', '--hard', a);
    const b = s.commit('two, fixed');
    git(s.dev, 'tag', '-f', 'v1.0.1');
    git(s.dev, 'push', '-q', '-f', 'origin', 'main', 'v1.0.1');
    const { execFile, ran } = exec();
    const out = await runAutoUpdate(opts(execFile));
    assert.equal(out.outcome, APPLIED, `${JSON.stringify(out)}\n${ran.join('\n')}`);
    assert.equal(git(s.machine, 'rev-parse', 'HEAD'), b, 'follows the tag where GitHub has it now');
  });

  it('installs packages without running their install scripts', { skip: !gitWorks && 'no git' }, async () => {
    s.commit('two');
    git(s.dev, 'tag', 'v1.0.1');
    git(s.dev, 'push', '-q', 'origin', 'main', 'v1.0.1');
    const { execFile, ran } = exec();
    await runAutoUpdate(opts(execFile));
    const npm = ran.find((r) => / install\b/.test(r) && !r.startsWith('git'));
    assert.ok(npm, ran.join('\n'));
    assert.match(npm, /--ignore-scripts/);
  });
});

describe('update-to-release.mjs, used by the session hook, the upgraders and the AI', () => {
  const cli = path.join(root, 'scripts', 'install-helpers', 'update-to-release.mjs');
  const run = () => spawnSync(process.execPath, [cli], { cwd: s.machine, encoding: 'utf8', env: ENV });

  it('moves to the newest release and says so', { skip: !gitWorks && 'no git' }, () => {
    const released = s.commit('two');
    git(s.dev, 'tag', 'v1.0.1');
    s.commit('three, not released');
    git(s.dev, 'push', '-q', 'origin', 'main', 'v1.0.1');
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^UPDATED v1\.0\.1$/m);
    assert.equal(git(s.machine, 'rev-parse', 'HEAD'), released);
  });

  it('reports CURRENT when there is nothing to do', { skip: !gitWorks && 'no git' }, () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^CURRENT v1\.0\.0$/m);
  });

  it('forgets a release tag deleted on GitHub (one pushed by mistake)', { skip: !gitWorks && 'no git' }, () => {
    s.commit('two');
    git(s.dev, 'tag', 'v2.0.0');
    git(s.dev, 'push', '-q', 'origin', 'main', 'v2.0.0');
    const print = () => spawnSync(process.execPath, [cli, '--print'], { cwd: s.machine, encoding: 'utf8', env: ENV }).stdout.trim();
    assert.equal(print(), 'v2.0.0');
    git(s.dev, 'push', '-q', 'origin', ':refs/tags/v2.0.0');
    assert.equal(print(), 'v1.0.0', 'the deleted tag must not stay the newest release here');
  });

  it('offline, --print --no-fetch answers from the tags already here', { skip: !gitWorks && 'no git' }, () => {
    // check-sync uses this rather than falling back to main, which would report every
    // untagged commit on main as "behind".
    git(s.machine, 'remote', 'set-url', 'origin', path.join(s.base, 'gone.git'));
    const r = (...a) => spawnSync(process.execPath, [cli, ...a], { cwd: s.machine, encoding: 'utf8', env: ENV });
    assert.notEqual(r('--print').status, 0, 'the fetch fails offline');
    const off = r('--print', '--no-fetch');
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.stdout.trim(), 'v1.0.0');
  });

  it('keeps uncommitted changes in the checkout', { skip: !gitWorks && 'no git' }, () => {
    s.commit('two');
    git(s.dev, 'tag', 'v1.0.1');
    git(s.dev, 'push', '-q', 'origin', 'main', 'v1.0.1');
    fs.writeFileSync(path.join(s.machine, 'local.txt'), 'mine');
    fs.writeFileSync(path.join(s.machine, 'f.txt'), 'one');
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(s.machine, 'local.txt'), 'utf8'), 'mine');
  });
});

describe('every update path uses the release, not main', () => {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  it('the command the AI runs on an upgrade notice', async () => {
    const { UPGRADE_COMMAND } = await import('../mcp/lib/upgrade-notice.js');
    assert.match(UPGRADE_COMMAND, /update-to-release\.mjs/);
    assert.doesNotMatch(UPGRADE_COMMAND, /git pull/);
    assert.match(UPGRADE_COMMAND, /npm install --ignore-scripts/);
  });
  for (const rel of ['hooks/ownmind-session-start.sh', 'scripts/interactive-upgrade.sh', 'scripts/interactive-upgrade.ps1']) {
    it(rel, () => {
      const code = read(rel).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      assert.match(code, /update-to-release\.mjs/);
      assert.doesNotMatch(code, /git pull|reset --hard origin\/main/);
    });
  }
  // Review finding: the upgraders re-run the installer, whose plain `git pull` carried them
  // on to main's tip. The pull stays only as the fallback for a checkout without the helper.
  for (const rel of ['install.sh', 'install.ps1']) {
    it(`${rel} updates an existing checkout and a fresh clone to the release`, () => {
      const code = read(rel);
      assert.match(code, /update-to-release\.mjs/);
      assert.match(code, /--print/, 'a fresh clone steps back to the newest release');
      assert.match(code, /reset -q --hard "refs\/tags\/\$release"|reset -q --hard "refs\/tags\/\$RELEASE"/);
    });
  }
  for (const rel of ['scripts/check-sync.sh', 'scripts/check-sync.ps1']) {
    it(`${rel} compares with the release, so untagged commits on main are not "behind"`, () => {
      assert.match(read(rel), /update-to-release\.mjs/);
      assert.match(read(rel), /merge-base --is-ancestor/);
    });
  }

  it('the sync scripts pin the packages they add, and skip install scripts', () => {
    for (const rel of ['scripts/update.sh', 'scripts/update.ps1']) {
      const code = read(rel).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      assert.doesNotMatch(code, /npm install [a-z-]+@\^/, `${rel}: no version ranges`);
      for (const m of code.matchAll(/npm install [a-z-]+@[0-9][^\n]*/g)) assert.match(m[0], /--ignore-scripts/, rel);
    }
  });
});

describe('sortReleaseTags', () => {
  it('orders by number, not text, and drops anything that is not vX.Y.Z', () => {
    assert.deepEqual(sortReleaseTags('v1.9.0\nv1.10.0\nv1.10.0-rc1\nlatest\nv1.2.3\n'), ['v1.10.0', 'v1.9.0', 'v1.2.3']);
  });
});
