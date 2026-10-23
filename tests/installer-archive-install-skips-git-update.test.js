import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * An archive install (a `.release` file and no `.git`) must not go through the installers'
 * "Updating OwnMind" branch: that branch runs update-to-release.mjs or `git pull`, both of
 * which need git, and bootstrap runs the installer right after unpacking the archive. Before
 * this check the very first install on a machine without git failed there.
 *
 * tests/bootstrap-archive-mode.e2e.mjs runs the real install.sh on an unpacked archive; this
 * file pins the same rule in both installers, including install.ps1, which only CI's Windows
 * leg can execute.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

test('install.sh: the archive check comes before, and short-circuits, the update branch', () => {
  const src = read('install.sh');
  // .release, or a swap journal (an update stopped part-way), and no .git.
  const archive = src.indexOf('if [ -d "$OWNMIND_DIR" ] && { [ -f "$OWNMIND_DIR/.release" ] || [ -f "$OWNMIND_DIR/.swap-journal.json" ]; } && [ ! -e "$OWNMIND_DIR/.git" ]; then');
  const update = src.indexOf('echo "[INFO] Updating OwnMind MCP server"');
  assert.ok(archive > 0, 'install.sh has no archive-install check');
  assert.ok(update > archive, 'the archive check must come before the update branch');
  const between = src.slice(archive, update);
  assert.match(between, /\[INFO\] Archive install \$\(head -n 1 "\$OWNMIND_DIR\/\.release"/);
  assert.match(between, /updates come from the OwnMind server"\nelif \[ -d "\$OWNMIND_DIR" \]; then\n\s*$/,
    'the update branch must be the elif of the archive check, so an archive install never enters it');
});

test('install.ps1: the archive check comes before, and short-circuits, the update branch', () => {
  const src = read('install.ps1');
  const archive = src.indexOf('if ((Test-Path $OwnmindDir) -and ((Test-Path $ReleaseFile) -or (Test-Path (Join-Path $OwnmindDir ".swap-journal.json"))) -and -not (Test-Path (Join-Path $OwnmindDir ".git"))) {');
  const update = src.indexOf('Write-Host "[INFO] Updating OwnMind MCP server"');
  assert.ok(archive > 0, 'install.ps1 has no archive-install check');
  assert.ok(update > archive, 'the archive check must come before the update branch');
  const between = src.slice(archive, update);
  assert.match(between, /\$ReleaseFile = Join-Path \$OwnmindDir "\.release"|Write-Host "\[INFO\] Archive install \$archiveRelease; updates come from the OwnMind server"/);
  assert.match(between, /\} elseif \(Test-Path \$OwnmindDir\) \{\r?\n\s*$/,
    'the update branch must be the elseif of the archive check');
  assert.match(src, /\$ReleaseFile = Join-Path \$OwnmindDir "\.release"\r?\n# [^\r\n]*\r?\nif \(\(Test-Path \$OwnmindDir\)/);
});
