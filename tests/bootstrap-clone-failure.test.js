import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
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
      // The OwnMind server at port 9 refuses; without this the archive fallback would go on to
      // GitHub and download the real release into the test home.
      OWNMIND_SOURCE: 'server',
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

/**
 * Issue #200, item 2: a network that blocks GitHub but reaches the OwnMind server. The clone
 * fails, and the install carries on from the server's release archive instead of stopping at
 * "check the network".
 */

/** A release archive whose install.sh only records that it ran, with the arguments it got. */
function fakeRelease() {
  const src = tempDir('bootstrap-fallback-src-');
  fs.writeFileSync(path.join(src, '.release'), 'v9.9.9\n');
  fs.writeFileSync(path.join(src, 'install.sh'),
    '#!/bin/bash\necho "installed-with:$1 $2" > "$HOME/install-ran.txt"\n', { mode: 0o755 });
  const out = path.join(tempDir('bootstrap-fallback-tar-'), 'archive.tar.gz');
  const tar = spawnSync('tar', ['-czf', out, '-C', src, '.release', 'install.sh']);
  assert.equal(tar.status, 0, String(tar.stderr));
  return fs.readFileSync(out);
}

/** Serves the archive at /api/install/archive to the right key only; counts the requests. */
async function archiveServer(body) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/api/install/archive' && req.headers.authorization === 'Bearer test-key') {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(body);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

/** spawnSync would block the in-process server, so this one is asynchronous. */
function runAsync(home, api, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', [bootstrap, 'test-key', api], {
      cwd: home,
      env: {
        PATH: `${failingGit()}:/usr/bin:/bin`,
        HOME: home,
        OWNMIND_DIR: path.join(home, '.ownmind'),
        OWNMIND_SOURCE: 'server',
        ...extraEnv,
      },
    });
    let said = '';
    child.stdout.on('data', (d) => { said += d; });
    child.stderr.on('data', (d) => { said += d; });
    child.on('close', (status) => resolve({ status, said }));
  });
}

describe('bootstrap.sh when the clone fails but the OwnMind server answers (issue #200)', () => {
  it('a first install finishes from the server archive', { skip }, async () => {
    const server = await archiveServer(fakeRelease());
    try {
      const home = tempDir('bootstrap-fallback-home-');
      const r = await runAsync(home, server.url);
      assert.equal(r.status, 0, r.said);
      assert.match(r.said, /ERROR:git_clone:/, 'the failed clone is still reported');
      assert.match(r.said, /git could not download OwnMind from GitHub; installing from the release archive/, r.said);
      assert.doesNotMatch(r.said, /ASK:no_network/, r.said);
      assert.ok(server.seen.includes('/api/install/archive'), `requests: ${server.seen}`);
      assert.equal(fs.readFileSync(path.join(home, '.ownmind', '.release'), 'utf8').trim(), 'v9.9.9');
      assert.equal(fs.readFileSync(path.join(home, 'install-ran.txt'), 'utf8').trim(),
        `installed-with:test-key ${server.url}`);
    } finally {
      await server.close();
    }
  });

  it('a repair keeps the old folder aside and finishes from the server archive', { skip }, async () => {
    const server = await archiveServer(fakeRelease());
    try {
      const home = tempDir('bootstrap-fallback-repair-');
      fs.mkdirSync(path.join(home, '.ownmind'));
      fs.writeFileSync(path.join(home, '.ownmind', 'leftover.txt'), 'an old, broken install\n');
      const r = await runAsync(home, server.url);
      assert.equal(r.status, 0, r.said);
      assert.match(r.said, /Repair complete \(old data preserved at /, r.said);
      assert.ok(fs.existsSync(path.join(home, '.ownmind', 'install.sh')));
      assert.ok(!fs.existsSync(path.join(home, '.ownmind', 'leftover.txt')), 'the new install does not carry the old files');
      const kept = fs.readdirSync(home).filter((n) => n.startsWith('.ownmind.broken.'));
      assert.equal(kept.length, 1);
    } finally {
      await server.close();
    }
  });
});
