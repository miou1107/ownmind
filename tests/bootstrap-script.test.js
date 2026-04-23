import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const shPath = join(__dirname, '..', 'scripts', 'bootstrap.sh');
const ps1Path = join(__dirname, '..', 'scripts', 'bootstrap.ps1');

test('bootstrap.sh exists and is executable', () => {
  const stat = statSync(shPath);
  assert.ok(stat.mode & 0o100, 'bootstrap.sh must have user-execute bit (chmod +x)');
});

test('bootstrap.sh handles all three install states', () => {
  const src = readFileSync(shPath, 'utf8');
  assert.match(src, /if\s+\[\s*!\s+-d\s+"?\$(?:HOME|OWNMIND_DIR)[^"]*"?\s*\]/,
    'expected "no install" branch (test for missing ~/.ownmind)');
  assert.match(src, /git\s+clone\s+"?\$(?:OWNMIND_)?REPO"?/,
    'expected git clone command');
  assert.match(src, /\.broken\./,
    'expected timestamp-suffixed backup directory name for broken state');
  assert.match(src, /interactive-upgrade\.sh/,
    'expected delegation to interactive-upgrade.sh for normal upgrade path');
});

test('bootstrap.sh uses INFO/OK/ERROR logging convention', () => {
  const src = readFileSync(shPath, 'utf8');
  assert.match(src, /INFO:[a-z_]+:/, 'expected INFO:<code>: log lines');
  assert.match(src, /OK:[a-z_]+:/,   'expected OK:<code>: log lines');
  assert.match(src, /ERROR:[a-z_]+:/, 'expected ERROR:<code>: log lines');
});

test('bootstrap.sh supports curl-pipe-bash (no stdin reads)', () => {
  const src = readFileSync(shPath, 'utf8');
  const hasUnguardedRead = /^read\s/m.test(src) && !/\[\s*-t\s+0\s*\]/.test(src);
  assert.equal(hasUnguardedRead, false,
    'bootstrap.sh must not prompt for input (would hang under curl | bash). Guard any `read` with a TTY check.');
});

test('bootstrap.ps1 exists', () => {
  statSync(ps1Path);
});

test('bootstrap.ps1 handles all three install states', () => {
  const src = readFileSync(ps1Path, 'utf8');
  assert.match(src, /Test-Path\s+(?:-?\w+\s+)?\$OwnmindDir/i,
    'expected Test-Path $OwnmindDir check (no install branch)');
  assert.match(src, /git\s+clone\s+\$Repo/i,
    'expected git clone $Repo command');
  assert.match(src, /\.broken\./,
    'expected timestamp-suffixed backup path for broken state');
  assert.match(src, /interactive-upgrade\.ps1/,
    'expected delegation to interactive-upgrade.ps1');
});

test('bootstrap.ps1 uses INFO/OK/ERROR logging convention', () => {
  const src = readFileSync(ps1Path, 'utf8');
  assert.match(src, /"INFO:[a-z_]+:/i);
  assert.match(src, /"OK:[a-z_]+:/i);
});
