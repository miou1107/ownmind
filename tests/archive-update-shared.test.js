// shared/archive-update.js — updates for a machine installed from a release archive (no git).
//
// Mirrors tests/auto-update-shared.test.js: the process runner, fetch and the file system are
// injected. `tar` is the real one, so the unpack step works on a real archive; npm and the
// installer are recorded instead of run.
//
// The update swaps code entries only: runtime/ (the private Node) and every other piece of
// runtime state must come out of an update as the very same files (same inodes), never copied.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tempDir } from './helpers/temp-dir.js';

const realExecFile = promisify(execFileCb);
const {
  runArchiveUpdate, compareReleases, rootDependencySpecs, privateNodeFor, removeTree, codeEntries,
  isStateEntry, SKIPPED, CLEAN, APPLIED, FAILED,
} = await import('../shared/archive-update.js');

const API_URL = 'https://ownmind.example.com';
const API_KEY = 'archive-update-key';
const skipPosix = process.platform === 'win32' ? 'uses tar and POSIX symlinks' : false;

let ROOT;
let dir;
let archives;

/** Write files from a { relativePath: content } map under `base`. */
function writeTree(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

/** A release archive (.tar.gz) the way the server builds one: .release at the root. */
function buildArchive(release, { omitInstaller = false, extra = {}, tag = 'ok' } = {}) {
  const src = path.join(ROOT, `src-${release}-${tag}`);
  writeTree(src, {
    '.release': `${release}\n`,
    ...(omitInstaller ? {} : { 'install.sh': '#!/bin/sh\nexit 0\n', 'install.ps1': '# installer\n' }),
    'package.json': JSON.stringify({ version: release.slice(1) }),
    'mcp/package.json': JSON.stringify({ name: 'ownmind-mcp' }),
    'mcp/index.js': `// ${release}\n`,
    '.gitignore': 'node_modules/\n',
    'scripts/update.sh': [
      '#!/bin/bash',
      'if needs_root_dep js-yaml 4.3.2; then',
      '  echo js-yaml',
      'fi',
      'if needs_root_dep node-machine-id 1.1.12; then',
      '  echo machine-id',
      'fi',
      '',
    ].join('\n'),
    ...extra,
  });
  const out = path.join(ROOT, `${release}-${tag}.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '-C', src, ...fs.readdirSync(src)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(out);
}

/** The live archive install: v1.0.0, a key file, logs, opt-outs and a private Node. */
function seedInstall() {
  writeTree(dir, {
    '.release': 'v1.0.0\n',
    'install.sh': '#!/bin/sh\n',
    'package.json': JSON.stringify({ version: '1.0.0' }),
    'mcp/index.js': '// v1.0.0\n',
    'mcp/node_modules/dep/index.js': 'module.exports = 1;\n',
    'credentials': 'secret-key-file\n',
    'cache/enforcement.json': '{"guards":[]}',
    'state/session.json': '{}',
    'logs/hook.log': 'line\n',
    'reports/touch.json': '[]',
    'git-hooks/pre-push': '#!/bin/sh\n# the user\'s own hook\n',
    'judge.json': '{"model":"x"}',
    '.no-usage-scanner': '',
    'runtime/node-v22.1.0/bin/node': '#!/bin/sh\necho v22.1.0\n',
  });
  fs.writeFileSync(path.join(dir, '.node-path'), `${path.join(dir, 'runtime', 'current', 'bin', 'node')}\n`);
  fs.symlinkSync('node-v22.1.0', path.join(dir, 'runtime', 'current'));
}

/** Inode (and link target) of every piece of runtime state, to prove none was moved or copied. */
const STATE = ['runtime', 'runtime/current', 'runtime/node-v22.1.0/bin/node', 'credentials', 'cache',
  'cache/enforcement.json', 'state', 'logs', 'logs/hook.log', 'reports', 'git-hooks', 'judge.json',
  '.no-usage-scanner', '.node-path'];
function stateSnapshot() {
  return Object.fromEntries(STATE.map((rel) => {
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    return [rel, { ino: st.ino, link: st.isSymbolicLink() ? fs.readlinkSync(p) : null }];
  }));
}

/** fetch: HEAD answers the server's release; GET answers the archive. */
function fakeFetch({ release = 'v1.1.0', archive = null, failGet = false } = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, auth: opts.headers?.Authorization });
    const headers = new Headers({ 'x-ownmind-release': release });
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    if (failGet) return new Response('nope', { status: 500 });
    return new Response(archive || archives[release], { status: 200, headers });
  };
  return { calls, fetch };
}

/** execFile: real tar; npm and the installer recorded, optionally failing. */
function fakeExec({ failNpm = false, failRootDeps = false, failInstaller = false, onInstall = null } = {}) {
  const calls = [];
  const execFile = async (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'tar') return realExecFile(cmd, args, opts);
    if (path.basename(cmd).startsWith('npm')) {
      if (failNpm) throw Object.assign(new Error('npm broke'), { code: 'NPM_FAIL' });
      if (failRootDeps && args.includes('--no-save')) {
        fs.writeFileSync(path.join(opts.cwd, 'node_modules', 'half-installed'), 'x');
        throw Object.assign(new Error('registry down'), { code: 'NPM_FAIL' });
      }
      return { stdout: '', stderr: '' };
    }
    if (cmd === 'bash' && onInstall) await onInstall();
    if (cmd === 'bash' && failInstaller) throw Object.assign(new Error('install failed'), { code: 1 });
    return { stdout: '', stderr: '' };
  };
  return { calls, execFile };
}

/** A file system whose renameSync throws `code` for the rename that `when(from, to)` picks. */
function failingRename(when, code = 'EBUSY') {
  const renames = [];
  return {
    renames,
    fileSystem: {
      ...fs,
      renameSync: (a, b) => {
        if (when(a, b)) throw Object.assign(new Error('resource busy'), { code });
        renames.push([a, b]);
        return fs.renameSync(a, b);
      },
    },
  };
}

function opts(over = {}) {
  const events = [];
  return {
    events,
    run: (extra = {}) => runArchiveUpdate({
      ownmindDir: dir,
      apiUrl: API_URL,
      apiKey: API_KEY,
      platform: 'darwin',
      nodeBin: path.join(ROOT, 'no-npm-here', 'node'),
      env: { PATH: '/usr/bin:/bin' },
      logEvent: (event, details) => events.push({ event, details }),
      now: () => new Date('2026-10-23T10:00:00Z'),
      ...over,
      ...extra,
    }),
  };
}

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const leftovers = () => fs.readdirSync(dir).filter((n) => ['.next', '.swap-journal.json', '.next.download'].includes(n));
const live = (rel) => path.join(dir, rel);

beforeEach(() => {
  ROOT = tempDir('ownmind-archive-update-');
  dir = path.join(ROOT, '.ownmind');
  fs.mkdirSync(dir);
  archives = { 'v1.1.0': buildArchive('v1.1.0'), 'v1.0.0': buildArchive('v1.0.0') };
});

describe('runArchiveUpdate', { skip: skipPosix }, () => {
  it('same release as the server: CLEAN, nothing downloaded, nothing moved', async () => {
    seedInstall();
    const f = fakeFetch({ release: 'v1.0.0' });
    const x = fakeExec();
    const r = await opts({ fetch: f.fetch, execFile: x.execFile }).run();
    assert.equal(r.outcome, CLEAN);
    assert.equal(r.from, 'v1.0.0');
    assert.deepEqual(f.calls.map((c) => c.method), ['HEAD']);
    assert.equal(f.calls[0].url, `${API_URL}/api/install/archive`);
    assert.equal(f.calls[0].auth, `Bearer ${API_KEY}`);
    assert.equal(x.calls.length, 0);
    assert.ok(!fs.existsSync(live('.prev')));
  });

  it('a server behind this machine is not a reason to go back', async () => {
    seedInstall();
    fs.writeFileSync(live('.release'), 'v1.2.0\n');
    const f = fakeFetch({ release: 'v1.1.0' });
    const r = await opts({ fetch: f.fetch, execFile: fakeExec().execFile }).run();
    assert.equal(r.outcome, CLEAN);
    assert.deepEqual(f.calls.map((c) => c.method), ['HEAD']);
  });

  it('newer release: APPLIED; code swapped into place, the old code in .prev, runtime and state the very same files', async () => {
    seedInstall();
    const before = stateSnapshot();
    const rec = failingRename(() => false);
    // After every rename the live tree must still have a .release (every archive check reads it).
    const watched = { ...rec.fileSystem, renameSync: (a, b) => { rec.fileSystem.renameSync(a, b); assert.ok(fs.existsSync(live('.release')), `no live .release after renaming ${a}`); } };
    const x = fakeExec();
    let pings = 0;
    const o = opts({ fetch: fakeFetch().fetch, execFile: x.execFile, fileSystem: watched, keepAlive: () => { pings += 1; } });
    const r = await o.run();
    assert.equal(r.outcome, APPLIED, JSON.stringify(o.events));
    assert.equal(r.from, 'v1.0.0');
    assert.equal(r.to, 'v1.1.0');
    assert.equal(r.version, '1.1.0');

    assert.equal(read(dir, '.release').trim(), 'v1.1.0');
    assert.equal(read(dir, 'mcp', 'index.js'), '// v1.1.0\n');
    assert.equal(read(dir, 'install.sh'), '#!/bin/sh\nexit 0\n');
    assert.equal(read(dir, '.prev', '.release').trim(), 'v1.0.0');
    assert.equal(read(dir, '.prev', 'mcp', 'index.js'), '// v1.0.0\n');
    assert.ok(fs.existsSync(live('mcp/node_modules/dep/index.js')), 'the staged mcp was seeded from the live node_modules');
    assert.deepEqual(leftovers(), [], 'no .next, journal or download left behind');

    // Runtime and state: same inodes, same link, never in .prev.
    assert.deepEqual(stateSnapshot(), before);
    assert.equal(read(dir, 'credentials'), 'secret-key-file\n');
    assert.ok(!fs.existsSync(live('.prev/runtime')) && !fs.existsSync(live('.prev/credentials')));
    // Only code entries were renamed, and .release last.
    const moved = rec.renames.filter(([a]) => !a.endsWith('.tmp')).map(([a]) => path.relative(dir, a));
    assert.ok(moved.every((m) => !/^(runtime|credentials|cache|state|logs|reports|git-hooks)(\/|$)/.test(m)), moved.join(','));
    assert.equal(moved.at(-1), path.join('.next', '.release'));

    // npm ran in .next/mcp, then the root dependencies update.sh names, in .next.
    const npmCalls = x.calls.filter((c) => c.cmd === 'npm');
    assert.equal(npmCalls.length, 2);
    assert.deepEqual(npmCalls[0].args, ['install', '-q', '--ignore-scripts']);
    assert.equal(npmCalls[0].opts.cwd, path.join(dir, '.next', 'mcp'));
    assert.deepEqual(npmCalls[1].args.slice(0, 3), ['install', 'js-yaml@4.3.2', 'node-machine-id@1.1.12']);
    assert.ok(npmCalls[1].args.includes('--ignore-scripts'));
    assert.equal(npmCalls[1].opts.cwd, path.join(dir, '.next'));

    // An automatic update reconfigures through the daily sync, never install.sh (which reloads
    // the scanner's launchd job and so kills a scanner that is the caller).
    const sync = x.calls.filter((c) => c.cmd === 'bash');
    assert.equal(sync.length, 1);
    assert.deepEqual(sync[0].args, [live('scripts/update.sh')]);
    assert.equal(sync[0].opts.env.OWNMIND_PRIVATE_NODE, '1');
    assert.equal(sync[0].opts.env.OWNMIND_NODE, live('runtime/current/bin/node'));
    assert.ok(!fs.existsSync(live('.reconfigure-pending')));
    assert.ok(pings >= 4, `the lock was refreshed only ${pings} times`);
    assert.ok(o.events.some((e) => e.event === 'update_applied' && e.details.mode === 'archive'));
  });

  it("reconfigure: 'install' (the interactive upgraders) re-runs install.sh with the key in the environment", async () => {
    seedInstall();
    const x = fakeExec();
    const r = await opts({ fetch: fakeFetch().fetch, execFile: x.execFile, reconfigure: 'install' }).run();
    assert.equal(r.outcome, APPLIED);
    const install = x.calls.filter((c) => c.cmd === 'bash');
    assert.equal(install.length, 1);
    assert.deepEqual(install[0].args, [live('install.sh'), '', API_URL]);
    assert.equal(install[0].opts.env.OWNMIND_INSTALL_KEY, API_KEY);
    assert.equal(install[0].opts.env.OWNMIND_PRIVATE_NODE, '1');
    assert.ok(!install[0].args.includes(API_KEY), 'the key never goes on a command line');
  });

  it('the lock is refreshed right before the reconfigure step, and on a timer while it runs', async (t) => {
    seedInstall();
    const seq = [];
    t.mock.timers.enable({ apis: ['setInterval'] });
    const x = fakeExec({
      onInstall: async () => {
        seq.push('reconfigure');
        t.mock.timers.tick(60_000 * 2 + 1); // a slow installer: two minutes
      },
    });
    await opts({ fetch: fakeFetch().fetch, execFile: x.execFile, keepAlive: () => { seq.push('ping'); } }).run();
    const at = seq.indexOf('reconfigure');
    assert.ok(at > 0, 'the reconfigure step ran');
    assert.equal(seq[at - 1], 'ping', 'refreshed just before it starts');
    assert.deepEqual(seq.slice(at + 1), ['ping', 'ping'], 'refreshed every minute while it runs, and not after');
  });

  it('a stuck swap with no live .release (journal: mcp done, .release staged) is still an archive install and resumes', async () => {
    seedInstall();
    writeTree(live('.next'), { '.release': 'v1.1.0\n' });
    fs.rmSync(live('mcp'), { recursive: true });
    writeTree(dir, { 'mcp/index.js': '// v1.1.0\n' });
    writeTree(live('.prev'), { 'mcp/index.js': '// v1.0.0\n' });
    fs.rmSync(live('.release'));
    fs.writeFileSync(live('.swap-journal.json'), JSON.stringify({ version: 1, from: 'v1.0.0', to: 'v1.1.0', entries: ['mcp', '.release'], done: ['mcp'] }));
    const f = fakeFetch();
    const r = await opts({ fetch: f.fetch, execFile: fakeExec().execFile }).run();
    assert.equal(r.outcome, APPLIED, JSON.stringify(r));
    assert.equal(r.from, 'v1.0.0');
    assert.equal(r.to, 'v1.1.0');
    assert.equal(read(dir, '.release').trim(), 'v1.1.0');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(leftovers(), []);
  });

  it('root dependencies failing: the staged node_modules is dropped, so the live one stays', async () => {
    seedInstall();
    writeTree(dir, { 'node_modules/js-yaml/package.json': '{"version":"4.1.0"}' });
    const ino = fs.statSync(live('node_modules')).ino;
    const o = opts({ fetch: fakeFetch().fetch, execFile: fakeExec({ failRootDeps: true }).execFile });
    const r = await o.run();
    assert.equal(r.outcome, APPLIED, 'the root dependencies are not fatal');
    assert.equal(fs.statSync(live('node_modules')).ino, ino);
    assert.ok(!fs.existsSync(live('node_modules/half-installed')));
    assert.ok(o.events.some((e) => e.event === 'update_root_deps_failed'));
  });

  it('CLEAN with no journal removes a staging a crash left behind', async () => {
    seedInstall();
    writeTree(live('.next'), { 'mcp/index.js': 'half' });
    fs.writeFileSync(live('.next.download'), 'half');
    const r = await opts({ fetch: fakeFetch({ release: 'v1.0.0' }).fetch, execFile: fakeExec().execFile }).run();
    assert.equal(r.outcome, CLEAN);
    assert.deepEqual(leftovers(), []);
  });

  it('npm failing: FAILED, the live tree untouched, staging gone', async () => {
    seedInstall();
    const mcpIno = fs.statSync(live('mcp')).ino;
    const x = fakeExec({ failNpm: true });
    const r = await opts({ fetch: fakeFetch().fetch, execFile: x.execFile }).run();
    assert.equal(r.outcome, FAILED);
    assert.equal(r.reason, 'npm');
    assert.equal(read(dir, '.release').trim(), 'v1.0.0');
    assert.equal(fs.statSync(live('mcp')).ino, mcpIno);
    assert.ok(!fs.existsSync(live('.prev')));
    assert.deepEqual(leftovers(), []);
    assert.ok(!x.calls.some((c) => c.cmd === 'bash'), 'no installer run without a swap');
  });

  it('download failing: FAILED, nothing left behind', async () => {
    seedInstall();
    const r = await opts({ fetch: fakeFetch({ failGet: true }).fetch, execFile: fakeExec().execFile }).run();
    assert.equal(r.outcome, FAILED);
    assert.equal(r.reason, 'download');
    assert.equal(read(dir, '.release').trim(), 'v1.0.0');
    assert.deepEqual(leftovers(), []);
  });

  it('an archive without the installer is refused before anything moves', async () => {
    seedInstall();
    const f = fakeFetch({ archive: buildArchive('v1.1.0', { omitInstaller: true, tag: 'broken' }) });
    const r = await opts({ fetch: f.fetch, execFile: fakeExec().execFile }).run();
    assert.equal(r.outcome, FAILED);
    assert.equal(r.reason, 'unpack');
    assert.equal(read(dir, '.release').trim(), 'v1.0.0');
    assert.deepEqual(leftovers(), []);
  });

  it('a release with an entry named like runtime state is refused before any rename', async () => {
    seedInstall();
    const before = stateSnapshot();
    const rec = failingRename(() => false);
    const f = fakeFetch({ archive: buildArchive('v1.1.0', { extra: { 'logs/oops.log': 'x' }, tag: 'collide' }) });
    const r = await opts({ fetch: f.fetch, execFile: fakeExec().execFile, fileSystem: rec.fileSystem }).run();
    assert.equal(r.outcome, FAILED);
    assert.equal(r.reason, 'state_collision');
    assert.deepEqual(rec.renames, [], 'nothing was renamed');
    assert.deepEqual(stateSnapshot(), before);
    assert.equal(read(dir, '.release').trim(), 'v1.0.0');
    assert.ok(!fs.existsSync(live('.prev')));
    assert.deepEqual(leftovers(), []);
  });

  it('EBUSY on the third entry: a journal, entries 1-2 new and the rest old; the next run finishes without a download', async () => {
    seedInstall();
    const before = stateSnapshot();
    // Entries in order: .gitignore, install.ps1, install.sh, mcp, package.json, scripts, .release.
    const busy = failingRename((a) => path.resolve(a) === path.resolve(live('install.sh')));
    const first = await opts({ fetch: fakeFetch().fetch, execFile: fakeExec().execFile, fileSystem: busy.fileSystem }).run();
    assert.equal(first.outcome, FAILED);
    assert.equal(first.reason, 'swap_pending');
    const journal = JSON.parse(read(dir, '.swap-journal.json'));
    assert.deepEqual(journal.entries, ['.gitignore', 'install.ps1', 'install.sh', 'mcp', 'package.json', 'scripts', '.release']);
    assert.deepEqual(journal.done, ['.gitignore', 'install.ps1']);
    assert.equal(read(dir, '.gitignore'), 'node_modules/\n', 'entry 1 is new');
    assert.equal(read(dir, 'install.ps1'), '# installer\n', 'entry 2 is new');
    assert.equal(read(dir, 'install.sh'), '#!/bin/sh\n', 'entry 3 is still the old one');
    assert.equal(read(dir, 'mcp', 'index.js'), '// v1.0.0\n');
    assert.equal(read(dir, '.release').trim(), 'v1.0.0', '.release changes last');
    assert.equal(read(dir, '.next', 'install.sh'), '#!/bin/sh\nexit 0\n', 'the new copy waits in .next');

    fs.writeFileSync(live('logs/later.log'), 'later\n');
    const f = fakeFetch();
    const x = fakeExec();
    const second = await opts({ fetch: f.fetch, execFile: x.execFile }).run();
    assert.equal(second.outcome, APPLIED);
    assert.equal(second.to, 'v1.1.0');
    assert.equal(f.calls.length, 0, 'the resume does not ask the server or download again');
    assert.ok(!x.calls.some((c) => c.cmd.startsWith('npm')), 'nor run npm again');
    assert.ok(x.calls.some((c) => c.cmd === 'bash'), 'the installer runs after the swap');
    assert.equal(read(dir, '.release').trim(), 'v1.1.0');
    assert.equal(read(dir, 'install.sh'), '#!/bin/sh\nexit 0\n');
    assert.equal(read(dir, 'mcp', 'index.js'), '// v1.1.0\n');
    assert.equal(read(dir, '.prev', 'install.sh'), '#!/bin/sh\n');
    assert.equal(read(dir, 'logs', 'later.log'), 'later\n');
    const { 'logs': _logs, ...rest } = before;
    const { 'logs': _logsAfter, ...restAfter } = stateSnapshot();
    assert.deepEqual(restAfter, rest);
    assert.deepEqual(leftovers(), []);
  });

  it('a failure between the two renames of one entry puts its old copy back, and the next run completes it', async () => {
    seedInstall();
    const busy = failingRename((a, b) => path.resolve(a) === path.resolve(live('.next/mcp')) && path.resolve(b) === path.resolve(live('mcp')));
    const first = await opts({ fetch: fakeFetch().fetch, execFile: fakeExec().execFile, fileSystem: busy.fileSystem }).run();
    assert.equal(first.reason, 'swap_pending');
    assert.equal(read(dir, 'mcp', 'index.js'), '// v1.0.0\n', 'the live tree is whole: old mcp back in place');
    assert.ok(!fs.existsSync(live('.prev/mcp')));
    const second = await opts({ fetch: fakeFetch().fetch, execFile: fakeExec().execFile }).run();
    assert.equal(second.outcome, APPLIED);
    assert.equal(read(dir, 'mcp', 'index.js'), '// v1.1.0\n');
    assert.equal(read(dir, '.prev', 'mcp', 'index.js'), '// v1.0.0\n');
  });

  it('the installer failing after the swap is retried by the next run', async () => {
    seedInstall();
    const first = await opts({ fetch: fakeFetch().fetch, execFile: fakeExec({ failInstaller: true }).execFile }).run();
    assert.equal(first.outcome, FAILED);
    assert.equal(first.reason, 'reconfigure');
    assert.equal(read(dir, '.release').trim(), 'v1.1.0');
    assert.ok(fs.existsSync(live('.reconfigure-pending')));

    const x = fakeExec();
    const second = await opts({ fetch: fakeFetch().fetch, execFile: x.execFile }).run();
    assert.equal(second.outcome, APPLIED);
    assert.ok(x.calls.some((c) => c.cmd === 'bash'));
    assert.ok(!fs.existsSync(live('.reconfigure-pending')));
  });

  it('a second update empties .prev first and still never touches runtime', async () => {
    seedInstall();
    const before = stateSnapshot();
    assert.equal((await opts({ fetch: fakeFetch().fetch, execFile: fakeExec().execFile }).run()).outcome, APPLIED);
    archives['v1.2.0'] = buildArchive('v1.2.0');
    const r2 = await opts({ fetch: fakeFetch({ release: 'v1.2.0' }).fetch, execFile: fakeExec().execFile }).run();
    assert.equal(r2.outcome, APPLIED);
    assert.equal(read(dir, '.prev', '.release').trim(), 'v1.1.0');
    assert.deepEqual(stateSnapshot(), before);
  });

  it('a git checkout is not an archive install and is left alone', async () => {
    seedInstall();
    fs.mkdirSync(live('.git'));
    const f = fakeFetch();
    const r = await opts({ fetch: f.fetch, execFile: fakeExec().execFile }).run();
    assert.equal(r.outcome, SKIPPED);
    assert.equal(f.calls.length, 0);
  });

  it('no credentials: SKIPPED, no request', async () => {
    seedInstall();
    const f = fakeFetch();
    const r = await opts({ fetch: f.fetch, execFile: fakeExec().execFile, apiKey: '' }).run();
    assert.equal(r.outcome, SKIPPED);
    assert.equal(r.reason, 'no_credentials');
    assert.equal(f.calls.length, 0);
  });

  it('the server not answering a release: FAILED version_check, nothing touched', async () => {
    seedInstall();
    const fetch = async () => new Response(null, { status: 401 });
    const r = await opts({ fetch, execFile: fakeExec().execFile }).run();
    assert.equal(r.outcome, FAILED);
    assert.equal(r.reason, 'version_check');
    assert.equal(read(dir, '.release').trim(), 'v1.0.0');
  });

  it('Windows asks for the zip', async () => {
    seedInstall();
    const f = fakeFetch({ failGet: true });
    await opts({ fetch: f.fetch, execFile: fakeExec().execFile, platform: 'win32' }).run();
    assert.ok(f.calls.some((c) => c.method === 'GET' && c.url.endsWith('/api/install/archive?format=zip')));
  });
});

describe('helpers', () => {
  it('compareReleases orders vX.Y.Z numerically and puts main below every release', () => {
    assert.equal(compareReleases('v1.10.0', 'v1.9.9'), 1);
    assert.equal(compareReleases('v1.2.3', 'v1.2.3'), 0);
    assert.equal(compareReleases('v1.2.3', 'v1.3.0'), -1);
    assert.equal(compareReleases('main', 'v0.0.1'), -1);
    assert.equal(compareReleases('v0.0.1', 'main'), 1);
  });

  it('codeEntries puts .release last and throws on a runtime-state name', () => {
    const d = tempDir('ownmind-archive-entries-');
    writeTree(d, { '.release': 'v1\n', 'mcp/x': '', 'install.sh': '', '.gitignore': '' });
    assert.deepEqual(codeEntries(fs, d), ['.gitignore', 'install.sh', 'mcp', '.release']);
    for (const name of ['runtime', 'credentials', 'cache', 'state', 'logs', 'reports', '.node-path', '.no-usage-scanner',
      'judge.json', '.swap-pending', '.prev', '.next', '.no-anything-new', '.last-whatever']) {
      assert.ok(isStateEntry(name), name);
    }
    fs.mkdirSync(path.join(d, 'runtime'));
    assert.throws(() => codeEntries(fs, d), { code: 'state_collision' });
  });

  it('rootDependencySpecs reads the floors scripts/update.sh installs', () => {
    const text = fs.readFileSync(new URL('../scripts/update.sh', import.meta.url), 'utf8');
    const specs = rootDependencySpecs(text);
    assert.ok(specs.some((s) => s.startsWith('js-yaml@')), `js-yaml missing from ${specs}`);
  });

  it('privateNodeFor names the node only when it lives under runtime/', () => {
    const d = path.join(tempDir('ownmind-archive-node-'), '.ownmind');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, '.node-path'), `${path.join(d, 'runtime', 'current', 'bin', 'node')}\n`);
    assert.equal(privateNodeFor(d), path.join(d, 'runtime', 'current', 'bin', 'node'));
    fs.writeFileSync(path.join(d, '.node-path'), '/opt/homebrew/bin/node\n');
    assert.equal(privateNodeFor(d), '');
  });

  it('removeTree unlinks runtime/current instead of following it', { skip: skipPosix }, () => {
    const base = tempDir('ownmind-archive-rm-');
    const target = path.join(base, 'node');
    writeTree(target, { 'bin/node': 'x' });
    const tree = path.join(base, 'tree');
    fs.mkdirSync(path.join(tree, 'runtime'), { recursive: true });
    fs.symlinkSync(target, path.join(tree, 'runtime', 'current'));
    removeTree(fs, tree);
    assert.ok(!fs.existsSync(tree));
    assert.ok(fs.existsSync(path.join(target, 'bin', 'node')));
  });
});
