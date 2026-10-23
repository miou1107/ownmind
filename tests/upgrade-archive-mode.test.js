// The upgraders on an archive install (a .release file and no .git): ARCHIVE_MODE skips the
// checkout's backup / pull / npm / install steps and runs shared/archive-update-cli.mjs instead.
// bootstrap delegates to an upgrader only while it contains the literal ARCHIVE_MODE.
//
// interactive-upgrade.sh is run for real against a local server for the two outcomes that leave
// the tree alone (already current, server failing); the swap itself is covered by
// tests/archive-update-shared.test.js and tests/bootstrap-archive-mode.e2e.mjs. The PowerShell
// side gets static checks (CI's Windows leg is the only place it can run).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { spawnBashScript } from './helpers/bash-script.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const KEY = 'upgrade-archive-key';
const skip = process.platform === 'win32' ? 'interactive-upgrade.sh is the Mac/Linux upgrader' : false;

describe('both upgraders carry the archive branch', () => {
  it('the literal ARCHIVE_MODE that bootstrap looks for is in both', () => {
    assert.match(read('scripts/interactive-upgrade.sh'), /ARCHIVE_MODE/);
    assert.match(read('scripts/interactive-upgrade.ps1'), /ARCHIVE_MODE/);
    // And bootstrap still keys on it.
    assert.match(read('scripts/bootstrap.sh'), /grep -q 'ARCHIVE_MODE' "\$OWNMIND_DIR\/scripts\/interactive-upgrade\.sh"/);
    assert.match(read('scripts/bootstrap.ps1'), /-Pattern 'ARCHIVE_MODE' -SimpleMatch/);
  });

  it('interactive-upgrade.sh: archive detection replaces the no_git stop, and the branch skips steps 1-4', () => {
    const sh = read('scripts/interactive-upgrade.sh');
    assert.match(sh, /if \[ ! -e "\$\{OWNMIND_DIR\}\/\.git" \] && \{ \[ -f "\$\{OWNMIND_DIR\}\/\.release" \] \|\| \[ -f "\$\{OWNMIND_DIR\}\/\.swap-journal\.json" \]; \}; then ARCHIVE_MODE=1; fi/);
    assert.match(sh, /\[ "\$\{ARCHIVE_MODE\}" = "1" \] \|\| \[ -d "\$\{OWNMIND_DIR\}\/\.git" \] \|\| FAIL "no_git"/);
    const preflight = sh.indexOf('ownmind_preflight_assert "upgrade"');
    const branch = sh.indexOf('if [ "${ARCHIVE_MODE}" = "1" ]; then\n  # --- 1-4 (archive install)');
    const cli = sh.indexOf('node "${OWNMIND_DIR_WIN}/shared/archive-update-cli.mjs" --dir "${OWNMIND_DIR_WIN}"');
    const backup = sh.indexOf('# --- 1. Backup ---');
    const end = sh.indexOf('fi # end of steps 1-4 for a git checkout (ARCHIVE_MODE=0)');
    const step5 = sh.indexOf('# --- 5. Re-register the scheduled task ---');
    assert.ok(preflight > 0 && branch > preflight, 'the archive branch comes after the preflight');
    assert.ok(cli > branch && backup > cli, 'the archive update runs in the branch, before the checkout steps');
    assert.ok(end > backup && step5 > end, 'steps 1-4 are closed off before step 5, which both kinds run');
  });

  it('interactive-upgrade.ps1: the same branch; a stopped swap is resumed by the next run, never redone in PowerShell', () => {
    const ps = read('scripts/interactive-upgrade.ps1');
    assert.match(ps, /\$ArchiveMode = \(-not \(Test-Path \(Join-Path \$OwnMindDir "\.git"\)\)\) -and \(\(Test-Path \(Join-Path \$OwnMindDir "\.release"\)\) -or \(Test-Path \(Join-Path \$OwnMindDir "\.swap-journal\.json"\)\)\)/);
    assert.match(ps, /if \(-not \$ArchiveMode -and -not \(Test-Path \(Join-Path \$OwnMindDir "\.git"\)\)\) \{ Fail "no_git"/);
    const preflight = ps.indexOf("Assert-OwnMindRequirements -Stage 'upgrade'");
    const branch = ps.indexOf('if ($ArchiveMode) {');
    const cli = ps.indexOf("& node (Join-Path $OwnMindDir 'shared\\archive-update-cli.mjs') --dir $OwnMindDir 2>&1");
    const backup = ps.indexOf('# --- 1. Backup ---');
    const end = ps.indexOf('} # end of steps 1-4 for a git checkout (ARCHIVE_MODE off)');
    const step5 = ps.indexOf('# --- 5. Re-register Task Scheduler ---');
    assert.ok(preflight > 0 && branch > preflight);
    assert.ok(cli > branch && backup > cli);
    assert.ok(end > backup && step5 > end);
    // The code-only swap never renames the install itself, so PowerShell has no swap of its own.
    assert.doesNotMatch(ps, /Complete-OwnMindArchiveSwap|Move-Item -LiteralPath \$OwnMindDir/);
    assert.match(ps, /\$archiveResult -match '\^FAILED \(swap_pending\|swap\)\$'/);
    assert.match(ps, /\$BackupDir = Join-Path \$OwnMindDir "\.prev"/);
  });
});

describe('the daily sync passes the private Node to the hook helpers', () => {
  it('update.sh adds --node-bin only when .node-path points into runtime/', () => {
    const sh = read('scripts/update.sh');
    assert.match(sh, /case "\$update_node_path" in "\$OWNMIND_DIR\/runtime\/"\*\) UPDATE_NODE_BIN="\$update_node_path" ;; esac/);
    for (const helper of ['ENSURE_PRE_HOOK', 'ENSURE_HOOK', 'ADD_STOP_HOOK_HELPER', 'ADD_POST_HOOK_HELPER']) {
      assert.match(sh, new RegExp(`node "\\$${helper}"[^\\n]*--ownmind-dir "\\$OWNMIND_DIR" \\$\\{UPDATE_NODE_BIN:\\+--node-bin "\\$UPDATE_NODE_BIN"\\}`), helper);
    }
  });

  it('update.ps1 does the same with @NodeBinArgs', () => {
    const ps = read('scripts/update.ps1');
    assert.match(ps, /\$NodeBinArgs = @\('--node-bin', \$namedNode\)/);
    assert.match(ps, /\.StartsWith\(\(Join-Path \$OwnMindDir "runtime\\"\)\.ToLower\(\)\)/);
    for (const helper of ['EnsurePreHook', 'EnsureHook', 'AddStopHookHelper', 'AddPostHookHelper']) {
      assert.match(ps, new RegExp(`& node \\$${helper}\\b[^\\r\\n]*--ownmind-dir \\$OwnMindDir @NodeBinArgs`), helper);
    }
  });

  it('the bare-node expansion is empty without a private runtime, two words with one', () => {
    const run = (value) => {
      const r = spawnBashScript(`UPDATE_NODE_BIN='${value}'; set -- \${UPDATE_NODE_BIN:+--node-bin "$UPDATE_NODE_BIN"}; echo "$#:$*"`, { encoding: 'utf8' });
      return r.stdout.trim();
    };
    assert.equal(run(''), '0:');
    assert.equal(run('/Users/a b/.ownmind/runtime/current/bin/node'), '2:--node-bin /Users/a b/.ownmind/runtime/current/bin/node');
  });
});

// --- interactive-upgrade.sh for real ---

const server = { http: null, url: '', release: 'v1.34.0', mode: 'ok', requests: [] };
before(async () => {
  server.http = http.createServer((req, res) => {
    server.requests.push(`${req.method} ${req.url}`);
    if (req.url.startsWith('/api/install/archive')) {
      if (server.mode !== 'ok') { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'x-ownmind-release': server.release });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  await new Promise((resolve) => server.http.listen(0, '127.0.0.1', resolve));
  server.url = `http://127.0.0.1:${server.http.address().port}`;
});
after(() => new Promise((resolve) => server.http.close(resolve)));

function archiveHome(release) {
  const home = tempDir('upgrade-archive-');
  const dir = path.join(home, '.ownmind');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.release'), `${release}\n`);
  fs.writeFileSync(path.join(dir, 'install.sh'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: release.slice(1) }));
  for (const name of ['shared', 'scripts']) fs.symlinkSync(path.join(repoRoot, name), path.join(dir, name));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    mcpServers: { ownmind: { env: { OWNMIND_API_KEY: KEY, OWNMIND_API_URL: server.url } } },
  }));
  return home;
}

function upgrade(home) {
  return new Promise((resolve, reject) => {
    const { OWNMIND_API_KEY, OWNMIND_API_URL, ...env } = process.env;
    const child = spawn('bash', [path.join(repoRoot, 'scripts', 'interactive-upgrade.sh')], {
      env: { ...env, HOME: home, USERPROFILE: home, OWNMIND_BACKUP_RETENTION_DAYS: '7' },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, out }));
  });
}

describe('interactive-upgrade.sh on an archive install', { skip }, () => {
  it('already current: the archive update answers, and no backup or pull happens', async () => {
    server.mode = 'ok';
    server.release = 'v1.34.0';
    server.requests = [];
    const home = archiveHome('v1.34.0');
    const r = await upgrade(home);
    assert.match(r.out, /^INFO:archive_mode:Archive install \(v1\.34\.0\); updating from the OwnMind server instead of git$/m, r.out);
    assert.match(r.out, /^OK:archive_update:Already on the server's release \(v1\.34\.0\)$/m, r.out);
    assert.doesNotMatch(r.out, /^INFO:(backup|pull|npm_install):/m);
    assert.doesNotMatch(r.out, /ERROR:no_git/);
    assert.ok(server.requests.includes('HEAD /api/install/archive'), server.requests.join(','));
    assert.deepEqual(fs.readdirSync(home).filter((n) => n.startsWith('.ownmind.')), [], 'no backup, no .prev, no .next');
  });

  it('server failing: ERROR:archive_update, and the install is untouched', async () => {
    server.mode = '500';
    const home = archiveHome('v1.34.0');
    const r = await upgrade(home);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /^ERROR:archive_update:Archive update failed \(FAILED version_check\); nothing was changed/m, r.out);
    assert.equal(fs.readFileSync(path.join(home, '.ownmind', '.release'), 'utf8').trim(), 'v1.34.0');
    assert.deepEqual(fs.readdirSync(home).filter((n) => n.startsWith('.ownmind.')), []);
  });
});
