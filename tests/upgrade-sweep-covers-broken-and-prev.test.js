// The seven-day sweep at the end of an upgrade covers every copy of ~/.ownmind left beside it:
// upgrade backups (.ownmind.bak.<ts>), directories bootstrap set aside as broken
// (.ownmind.broken.<ts>) and the release an archive update replaced (.ownmind.prev). Each may hold
// runtime/current, a link to the private Node, and a sweep must remove that link, never what it
// points at: on Windows the junction in .prev names the LIVE tree's Node.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { spawnBashScript, toBashPath } from './helpers/bash-script.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(repoRoot, 'scripts', 'install-helpers', 'sweep-old-trees.sh');
const skip = process.platform === 'win32' ? 'a bash helper with POSIX symlinks' : false;
const DAY = 86400 * 1000;

function makeTree(dir, ageDays, { link = null } = {}) {
  fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker'), 'x');
  if (link) fs.symlinkSync(link, path.join(dir, 'runtime', 'current'));
  const t = (Date.now() - ageDays * DAY) / 1000;
  fs.utimesSync(dir, t, t);
}

function sweep(home, days = 7) {
  const r = spawnBashScript(`. "${toBashPath(helper)}"; ownmind_sweep_old_trees "${toBashPath(home)}" "${Number(days)}"`, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

describe('ownmind_sweep_old_trees', { skip }, () => {
  it('removes .broken.*, .prev and .bak.* older than the retention, keeps recent ones', () => {
    const home = tempDir('ownmind-sweep-trees-');
    makeTree(path.join(home, '.ownmind.broken.20261001-101010'), 14);
    makeTree(path.join(home, '.ownmind.broken.20261020-101010'), 2);
    makeTree(path.join(home, '.ownmind.prev'), 10);
    makeTree(path.join(home, '.ownmind.bak.20261001-090000'), 12);
    makeTree(path.join(home, '.ownmind.bak.20261022-090000'), 1);
    makeTree(path.join(home, '.ownmind'), 30); // the live install is never a candidate
    sweep(home);
    assert.deepEqual(fs.readdirSync(home).sort(), [
      '.ownmind',
      '.ownmind.bak.20261022-090000',
      '.ownmind.broken.20261020-101010',
    ]);
  });

  it('a link inside an old tree is unlinked, not followed', () => {
    const home = tempDir('ownmind-sweep-trees-');
    // The live Node, which the old tree's runtime/current points at by absolute path.
    const liveNode = path.join(home, '.ownmind', 'runtime', 'node-v22.1.0');
    fs.mkdirSync(path.join(liveNode, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(liveNode, 'bin', 'node'), 'the live node');
    makeTree(path.join(home, '.ownmind.broken.20261001-101010'), 14, { link: liveNode });
    makeTree(path.join(home, '.ownmind.prev'), 14, { link: liveNode });
    sweep(home);
    assert.ok(!fs.existsSync(path.join(home, '.ownmind.broken.20261001-101010')));
    assert.ok(!fs.existsSync(path.join(home, '.ownmind.prev')));
    assert.equal(fs.readFileSync(path.join(liveNode, 'bin', 'node'), 'utf8'), 'the live node');
  });

  it('the .prev an archive update keeps inside the install is swept the same way', () => {
    const home = tempDir('ownmind-sweep-trees-');
    makeTree(path.join(home, '.ownmind', '.prev'), 10);
    fs.mkdirSync(path.join(home, '.ownmind', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ownmind', 'runtime', 'node'), 'live');
    sweep(home);
    assert.ok(!fs.existsSync(path.join(home, '.ownmind', '.prev')));
    assert.equal(fs.readFileSync(path.join(home, '.ownmind', 'runtime', 'node'), 'utf8'), 'live');
    makeTree(path.join(home, '.ownmind', '.prev'), 1);
    sweep(home);
    assert.ok(fs.existsSync(path.join(home, '.ownmind', '.prev')), 'a recent .prev stays');
  });

  it('a link named like a candidate is left alone rather than followed', () => {
    const home = tempDir('ownmind-sweep-trees-');
    const elsewhere = path.join(home, 'elsewhere');
    makeTree(elsewhere, 30);
    fs.symlinkSync(elsewhere, path.join(home, '.ownmind.prev'));
    sweep(home);
    assert.ok(fs.existsSync(path.join(elsewhere, 'marker')));
  });
});

describe('both upgraders use the sweep on every kind of old tree', () => {
  it('interactive-upgrade.sh sources the helper and keeps the plain find for older releases', () => {
    const sh = fs.readFileSync(path.join(repoRoot, 'scripts', 'interactive-upgrade.sh'), 'utf8');
    assert.match(sh, /\. "\$\{SWEEP_HELPER\}"\n\s*ownmind_sweep_old_trees "\$\{HOME\}" "\$\{RETENTION_DAYS\}"/);
  });

  it('interactive-upgrade.ps1 sweeps .broken.* and .prev through the junction-safe delete', () => {
    const ps = fs.readFileSync(path.join(repoRoot, 'scripts', 'interactive-upgrade.ps1'), 'utf8');
    assert.match(ps, /\$_\.Name -like '\.ownmind\.broken\.\*'/);
    assert.match(ps, /\$_\.Name -eq '\.ownmind\.prev'/);
    assert.match(ps, /\$innerPrev = Join-Path \$OwnMindDir '\.prev'[\s\S]*?try \{ Remove-OwnMindTreeSafe -Path \$innerPrev \} catch \{ \}/);
    assert.match(ps, /ForEach-Object \{ try \{ Remove-OwnMindTreeSafe -Path \$_\.FullName \} catch \{ \} \}/);
    // A junction is skipped by the filter, never handed to a recursive delete.
    assert.match(ps, /\(\$_\.Attributes -band \[System\.IO\.FileAttributes\]::ReparsePoint\) -eq 0/);
  });

  it('interactive-upgrade.ps1 has no recursive copy or delete of the tree that skips the junction', () => {
    const ps = fs.readFileSync(path.join(repoRoot, 'scripts', 'interactive-upgrade.ps1'), 'utf8');
    const code = ps.split(/\r?\n/).filter((l) => !l.trim().startsWith('#'));
    const recursive = code.filter((l) => /(Remove-Item|Copy-Item)\b.*-Recurse/.test(l));
    // The only two left are inside the safe helpers themselves.
    assert.deepEqual(recursive.map((l) => l.trim()), [
      'Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop',
      'Copy-Item -Recurse -Path $From -Destination $To',
    ]);
    assert.match(ps, /Copy-OwnMindTreeSafe -From \$OwnMindDir -To \$BackupDir/);
    assert.match(ps, /Remove-OwnMindTreeSafe -Path \$OwnMindDir\r?\n\s*Move-Item -Path \$BackupDir/);
    assert.match(ps, /\[System\.IO\.Directory\]::Delete\(\$link\)/);
  });

  it('bootstrap resets the modification time of a tree it sets aside, so the sweep counts from then', () => {
    const sh = fs.readFileSync(path.join(repoRoot, 'scripts', 'bootstrap.sh'), 'utf8');
    assert.match(sh, /mv "\$OWNMIND_DIR" "\$BAK" \|\| \{[^\n]*\n[^\n]*\n\s*touch "\$BAK" 2>\/dev\/null \|\| true/);
    const ps = fs.readFileSync(path.join(repoRoot, 'scripts', 'bootstrap.ps1'), 'utf8');
    assert.match(ps, /Move-Item "\$OwnmindDir" "\$Bak"\r?\n\s*try \{ \(Get-Item -LiteralPath \$Bak -Force -ErrorAction Stop\)\.LastWriteTime = Get-Date \} catch \{ \}/);
  });
});
