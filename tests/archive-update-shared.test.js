// shared/archive-update.js — updates for a machine installed from a release archive (no git).
//
// Mirrors tests/auto-update-shared.test.js: the process runner, fetch and the file system are
// injected. `tar` is the real one, so the unpack step works on a real archive; npm and the
// installer are recorded instead of run.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tempDir } from './helpers/temp-dir.js';

const realExecFile = promisify(execFileCb);
const {
  runArchiveUpdate, compareReleases, rootDependencySpecs, privateNodeFor, removeTree,
  SKIPPED, CLEAN, APPLIED, FAILED,
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
function buildArchive(release, { omitInstaller = false } = {}) {
  const src = path.join(ROOT, `src-${release}-${omitInstaller ? 'broken' : 'ok'}`);
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
  });
  const out = path.join(ROOT, `${release}-${omitInstaller ? 'broken' : 'ok'}.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '-C', src, ...fs.readdirSync(src)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(out);
}

/** The live archive install: v1.0.0, a key file, logs, opt-outs and a private Node. */
function seedInstall({ absoluteRuntimeTarget = null } = {}) {
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
    '.git-bash-path': 'C:/Git/bin/bash.exe\n',
    'runtime/node-v22.1.0/bin/node': '#!/bin/sh\necho v22.1.0\n',
  });
  fs.writeFileSync(path.join(dir, '.node-path'), `${path.join(dir, 'runtime', 'current', 'bin', 'node')}\n`);
  fs.symlinkSync(absoluteRuntimeTarget || 'node-v22.1.0', path.join(dir, 'runtime', 'current'));
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
function fakeExec({ failNpm = false, failInstaller = false } = {}) {
  const calls = [];
  const execFile = async (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'tar') return realExecFile(cmd, args, opts);
    if (path.basename(cmd).startsWith('npm')) {
      if (failNpm) throw Object.assign(new Error('npm broke'), { code: 'NPM_FAIL' });
      return { stdout: '', stderr: '' };
    }
    if (cmd === 'bash' && failInstaller) throw Object.assign(new Error('install failed'), { code: 1 });
    return { stdout: '', stderr: '' };
  };
  return { calls, execFile };
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
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const leftovers = () => fs.readdirSync(ROOT).filter((n) => n.startsWith('.ownmind.next'));

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
    assert.ok(!fs.existsSync(`${dir}.prev`));
  });

  it('a server behind this machine is not a reason to go back', async () => {
    seedInstall();
    fs.writeFileSync(path.join(dir, '.release'), 'v1.2.0\n');
    const f = fakeFetch({ release: 'v1.1.0' });
    const r = await opts({ fetch: f.fetch, execFile: fakeExec().execFile }).run();
    assert.equal(r.outcome, CLEAN);
    assert.deepEqual(f.calls.map((c) => c.method), ['HEAD']);
  });

  it('newer release: APPLIED; the old tree is .prev and the runtime state came along', async () => {
    seedInstall();
    const f = fakeFetch({ release: 'v1.1.0' });
    const x = fakeExec();
    const o = opts({ fetch: f.fetch, execFile: x.execFile });
    const r = await o.run();
    assert.equal(r.outcome, APPLIED, JSON.stringify(o.events));
    assert.equal(r.from, 'v1.0.0');
    assert.equal(r.to, 'v1.1.0');
    assert.equal(r.version, '1.1.0');

    assert.equal(read(dir, '.release').trim(), 'v1.1.0');
    assert.equal(read(dir, 'mcp', 'index.js'), '// v1.1.0\n');
    assert.equal(read(`${dir}.prev`, '.release').trim(), 'v1.0.0');
    assert.deepEqual(leftovers(), [], 'no .next or .next.partial may be left behind');

    // Carried over.
    assert.equal(read(dir, 'credentials'), 'secret-key-file\n');
    assert.equal(read(dir, 'cache', 'enforcement.json'), '{"guards":[]}');
    assert.equal(read(dir, 'logs', 'hook.log'), 'line\n');
    assert.ok(fs.existsSync(path.join(dir, 'state', 'session.json')));
    assert.ok(fs.existsSync(path.join(dir, 'reports', 'touch.json')));
    assert.match(read(dir, 'git-hooks', 'pre-push'), /the user's own hook/);
    assert.equal(read(dir, 'judge.json'), '{"model":"x"}');
    assert.ok(fs.existsSync(path.join(dir, '.no-usage-scanner')));
    assert.ok(fs.existsSync(path.join(dir, '.git-bash-path')));
    assert.equal(read(dir, '.node-path').trim(), path.join(dir, 'runtime', 'current', 'bin', 'node'));
    assert.equal(read(dir, '.gitignore'), 'node_modules/\n', 'a dotfile the release ships is the release\'s');
    assert.ok(fs.existsSync(path.join(dir, 'mcp', 'node_modules', 'dep', 'index.js')), 'dependencies seeded from the old tree');

    // The private Node: still a link, same target, and the copy it points to is there.
    const current = path.join(dir, 'runtime', 'current');
    assert.ok(isLink(current), 'runtime/current must stay a symlink');
    assert.equal(fs.readlinkSync(current), 'node-v22.1.0');
    assert.match(read(current, 'bin', 'node'), /v22\.1\.0/);
    assert.ok(fs.existsSync(path.join(`${dir}.prev`, 'runtime', 'node-v22.1.0', 'bin', 'node')));

    // npm ran in .next/mcp before the swap, then the root dependencies update.sh names.
    const npmCalls = x.calls.filter((c) => c.cmd === 'npm');
    assert.equal(npmCalls.length, 2);
    assert.deepEqual(npmCalls[0].args, ['install', '-q', '--ignore-scripts']);
    assert.equal(npmCalls[0].opts.cwd, path.join(`${dir}.next`, 'mcp'));
    assert.deepEqual(npmCalls[1].args.slice(0, 3), ['install', 'js-yaml@4.3.2', 'node-machine-id@1.1.12']);
    assert.ok(npmCalls[1].args.includes('--ignore-scripts'));
    assert.equal(npmCalls[1].opts.cwd, `${dir}.next`);

    // The installer re-ran from the new tree, the key in the environment, the private Node named.
    const install = x.calls.find((c) => c.cmd === 'bash');
    assert.deepEqual(install.args, [path.join(dir, 'install.sh'), '', API_URL]);
    assert.equal(install.opts.env.OWNMIND_INSTALL_KEY, API_KEY);
    assert.equal(install.opts.env.OWNMIND_PRIVATE_NODE, '1');
    assert.equal(install.opts.env.OWNMIND_NODE, path.join(dir, 'runtime', 'current', 'bin', 'node'));
    assert.ok(!install.args.includes(API_KEY), 'the key never goes on a command line');
    assert.ok(!fs.existsSync(path.join(dir, '.reconfigure-pending')));
    assert.ok(o.events.some((e) => e.event === 'update_applied' && e.details.mode === 'archive'));
  });

  it('npm failing: FAILED, the live tree untouched, .next gone', async () => {
    seedInstall();
    const x = fakeExec({ failNpm: true });
    const r = await opts({ fetch: fakeFetch().fetch, execFile: x.execFile }).run();
    assert.equal(r.outcome, FAILED);
    assert.equal(r.reason, 'npm');
    assert.equal(read(dir, '.release').trim(), 'v1.0.0');
    assert.equal(read(dir, 'mcp', 'index.js'), '// v1.0.0\n');
    assert.ok(isLink(path.join(dir, 'runtime', 'current')));
    assert.ok(!fs.existsSync(`${dir}.prev`));
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
    const f = fakeFetch({ archive: buildArchive('v1.1.0', { omitInstaller: true }) });
    const r = await opts({ fetch: f.fetch, execFile: fakeExec().execFile }).run();
    assert.equal(r.outcome, FAILED);
    assert.equal(r.reason, 'unpack');
    assert.equal(read(dir, '.release').trim(), 'v1.0.0');
    assert.deepEqual(leftovers(), []);
  });

  it('EBUSY on the swap: .swap-pending is written, and the next run only swaps', async () => {
    seedInstall();
    let blocked = 0;
    const busyFs = {
      ...fs,
      renameSync: (a, b) => {
        if (path.resolve(a) === path.resolve(dir)) {
          blocked += 1;
          throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
        }
        return fs.renameSync(a, b);
      },
    };
    const first = await opts({ fetch: fakeFetch().fetch, execFile: fakeExec().execFile, fileSystem: busyFs }).run();
    assert.equal(first.outcome, FAILED);
    assert.equal(first.reason, 'swap_pending');
    assert.equal(blocked, 1);
    assert.equal(read(dir, '.release').trim(), 'v1.0.0', 'the live tree is untouched');
    assert.equal(read(dir, '.swap-pending').split('\n')[0], `${dir}.next`);
    assert.equal(read(`${dir}.next`, '.release').trim(), 'v1.1.0', 'the prepared tree waits beside it');

    // Written after the first run: must still reach the new tree.
    fs.writeFileSync(path.join(dir, 'logs', 'later.log'), 'later\n');
    const f = fakeFetch();
    const x = fakeExec();
    const second = await opts({ fetch: f.fetch, execFile: x.execFile }).run();
    assert.equal(second.outcome, APPLIED);
    assert.equal(second.to, 'v1.1.0');
    assert.equal(f.calls.length, 0, 'the retry does not ask the server or download again');
    assert.ok(!x.calls.some((c) => c.cmd.startsWith('npm')), 'nor run npm again');
    assert.ok(x.calls.some((c) => c.cmd === 'bash'), 'the installer runs after the swap');
    assert.equal(read(dir, '.release').trim(), 'v1.1.0');
    assert.ok(!fs.existsSync(path.join(dir, '.swap-pending')));
    assert.equal(read(dir, 'logs', 'later.log'), 'later\n');
    assert.ok(isLink(path.join(dir, 'runtime', 'current')));
    assert.deepEqual(leftovers(), []);
  });

  it('the installer failing after the swap is retried by the next run', async () => {
    seedInstall();
    const first = await opts({ fetch: fakeFetch().fetch, execFile: fakeExec({ failInstaller: true }).execFile }).run();
    assert.equal(first.outcome, FAILED);
    assert.equal(first.reason, 'reconfigure');
    assert.equal(read(dir, '.release').trim(), 'v1.1.0');
    assert.ok(fs.existsSync(path.join(dir, '.reconfigure-pending')));

    const x = fakeExec();
    const second = await opts({ fetch: fakeFetch().fetch, execFile: x.execFile }).run();
    assert.equal(second.outcome, APPLIED);
    assert.ok(x.calls.some((c) => c.cmd === 'bash'));
    assert.ok(!fs.existsSync(path.join(dir, '.reconfigure-pending')));
  });

  it('an absolute runtime link: the swap and the next sweep of .prev never delete its target', async () => {
    const external = path.join(ROOT, 'external-node');
    writeTree(external, { 'bin/node': '#!/bin/sh\necho external\n' });
    seedInstall({ absoluteRuntimeTarget: external });

    const r1 = await opts({ fetch: fakeFetch().fetch, execFile: fakeExec().execFile }).run();
    assert.equal(r1.outcome, APPLIED);
    assert.equal(fs.readlinkSync(path.join(dir, 'runtime', 'current')), external);
    assert.ok(fs.existsSync(path.join(external, 'bin', 'node')));

    // The next update replaces .prev, which holds a link to the same target.
    archives['v1.2.0'] = buildArchive('v1.2.0');
    const r2 = await opts({ fetch: fakeFetch({ release: 'v1.2.0' }).fetch, execFile: fakeExec().execFile }).run();
    assert.equal(r2.outcome, APPLIED);
    assert.equal(read(`${dir}.prev`, '.release').trim(), 'v1.1.0');
    assert.ok(fs.existsSync(path.join(external, 'bin', 'node')), 'removing the old .prev followed the link');
    assert.ok(isLink(path.join(dir, 'runtime', 'current')));
  });

  it('a git checkout is not an archive install and is left alone', async () => {
    seedInstall();
    fs.mkdirSync(path.join(dir, '.git'));
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
