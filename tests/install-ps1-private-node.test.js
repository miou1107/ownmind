import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { nodeArchiveName, NODE_LTS_MAJOR } from '../shared/node-runtime.js';

/**
 * Static checks for the Windows private Node runtime: install.ps1 no longer installs git or
 * Node with winget, it calls Ensure-OwnMindNode; start.cmd finds the runtime first; the
 * preflight stops reporting a missing git or node as a failure.
 *
 * Text only: this suite runs on machines with no PowerShell. The behaviour runs on the Windows
 * leg of CI (tests/bootstrap-archive-mode-ps1.e2e.mjs).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

const installPs1 = read('install.ps1');
const ensurePs1 = read('scripts', 'install-helpers', 'ensure-node-runtime.ps1');
const ensureSh = read('scripts', 'install-helpers', 'ensure-node-runtime.sh');
const preflightPs1 = read('scripts', 'install-helpers', 'preflight.ps1');
const preflightSh = read('scripts', 'install-helpers', 'preflight.sh');
const startCmd = read('mcp', 'start.cmd');

test('install.ps1 installs neither git nor Node with winget', () => {
  assert.doesNotMatch(installPs1, /Install-WithWinget/);
  assert.doesNotMatch(installPs1, /Git\.Git/);
  assert.doesNotMatch(installPs1, /OpenJS\.NodeJS/);
  // winget stays for the optional sqlite3 step, which is already tolerant of failure
  assert.match(installPs1, /winget install --id SQLite\.SQLite/);
});

test('install.ps1 sources the helper and calls Ensure-OwnMindNode, deferring it until the checkout exists', () => {
  assert.match(installPs1, /\$NodeHelper = Join-Path \$HOME '\.ownmind\\scripts\\install-helpers\\ensure-node-runtime\.ps1'/);
  assert.match(installPs1, /\. \$NodeHelper\n\s+\$nodeOk = @\(Ensure-OwnMindNode -ApiUrl \$ApiUrl -ApiKey \$ApiKey\) \| Select-Object -Last 1/);
  assert.match(installPs1, /\$NodeStepPending = \$true/);
  // after the clone, before the release lookup that runs node
  const afterClone = installPs1.slice(installPs1.indexOf('git clone -q'));
  assert.ok(afterClone.indexOf('Invoke-NodeStep') < afterClone.indexOf('$ReleaseHelper --print'));
  // the floor of 20 is still enforced in install.ps1
  assert.match(installPs1, /\$nodeMajor -lt 20/);
});

test('a machine with no git and no folder yet is told to use bootstrap.ps1, not left with a failed git clone', () => {
  const clone = installPs1.slice(installPs1.indexOf('Cloning OwnMind MCP server'), installPs1.indexOf('git clone -q'));
  assert.match(clone, /Get-Command git -CommandType Application/);
  assert.match(clone, /Run bootstrap\.ps1, which installs from the release archive without git/);
});

test('install.ps1 does not write the node directory into the User PATH', () => {
  assert.doesNotMatch(code(installPs1), /SetEnvironmentVariable\(["']Path["'],[^)]*"User"\)/);
  assert.match(installPs1, /never through the User PATH/);
});

test('mcp/start.cmd looks for the private runtime before anything else', () => {
  const lines = startCmd.split('\n');
  const priv = lines.findIndex((l) => /runtime\\current\\node\.exe/i.test(l) && /^\s*IF EXIST/i.test(l));
  const where = lines.findIndex((l) => /where node/i.test(l) && /^\s*(IF|FOR)/i.test(l));
  const programFiles = lines.findIndex((l) => /^\s*IF "%NODE_EXE%"=="" IF EXIST "C:\\Program Files\\nodejs/i.test(l));
  assert.ok(priv > 0, 'start.cmd has no IF EXIST line for runtime\\current\\node.exe');
  assert.ok(priv < where, 'the private runtime must be tried before `where node`');
  assert.ok(where < programFiles);
  assert.match(lines[priv], /%USERPROFILE%\\\.ownmind\\runtime\\current\\node\.exe/);
  assert.match(lines[where], /^\s*IF "%NODE_EXE%"=="" FOR \/F/, '`where node` only runs when the private runtime was not found');
});

test('preflight.ps1: a missing git is not a failure without .git, a missing or old node is "no action needed"', () => {
  assert.match(preflightPs1, /\$script:OwnMindPreflightNoAction = '\(no action needed\)'/);
  assert.match(preflightPs1, /& \$add 'node' 'private runtime will be installed' \$script:OwnMindPreflightNoAction/);
  // the same words as the shell side
  assert.match(preflightSh, /node\\tprivate runtime will be installed\\t%s\\n/);
  assert.match(preflightSh, /OWNMIND_PREFLIGHT_NO_ACTION='\(no action needed\)'/);
  const assertFn = preflightPs1.slice(preflightPs1.indexOf('function Assert-OwnMindRequirements'));
  assert.match(assertFn, /Where-Object \{ \$_\.Remedy -ne \$script:OwnMindPreflightNoAction \}/);
  assert.match(assertFn, /Join-Path \$ownmindDir '\.git'/);
  assert.match(assertFn, /Where-Object \{ \$_\.Name -ne 'git' \}/);
  // winget no longer appears as the remedy for a missing node
  assert.doesNotMatch(code(preflightPs1).split('function Assert-OwnMindRequirements')[0].split("$node = Get-OwnMindToolPath 'node'")[1].split("$npm = ''")[0], /winget/);
  // npm is not asked about when node will be private
  assert.match(preflightPs1, /if \(-not \$nodePrivate\) \{ \$npm = Get-OwnMindToolPath 'npm' \}/);
});

test('ensure-node-runtime.ps1: same decisions, codes and sentences as the shell twin', () => {
  // order: system node, existing runtime, server, nodejs.org
  assert.match(ensurePs1, /Log-Info node "using system node \$sysVer"/);
  assert.match(ensurePs1, /Log-Info node "using private Node \$privVer"/);
  assert.match(ensurePs1, /Log-Ok node "private Node \$version installed"/);
  assert.match(ensureSh, /log_ok node "private Node \$version installed"/);
  assert.match(ensurePs1, /Log-Err node_download "Could not download Node\.js from the OwnMind server or nodejs\.org"/);
  // the ASK sentences the person reads are byte-identical
  const asks = [...ensureSh.matchAll(/ASK:no_network:[^"\n]*\./g)].map((m) => m[0]);
  assert.equal(asks.length, 2);
  for (const sentence of asks) {
    assert.ok(ensurePs1.includes(sentence), `ensure-node-runtime.ps1 is missing: ${sentence}`);
  }
  for (const line of [
    'trying the OwnMind server, then nodejs.org (this can take a few minutes when offline)',
    'The OwnMind server did not deliver Node.js; trying nodejs.org',
    'The OwnMind server did not send a version and checksum for Node.js',
    'Could not unpack the Node.js archive (it may be damaged)',
  ]) {
    assert.ok(ensureSh.includes(line), `${line} is not in the shell twin`);
    assert.ok(ensurePs1.includes(line), `${line} is missing from ensure-node-runtime.ps1`);
  }
  assert.match(ensurePs1, /Log-Err node_download "OWNMIND_NODE_SOURCE must be server or nodejs \(got: \$source\)"/);
});

test('ensure-node-runtime.ps1 downloads the win32 zip, verifies SHA-256, and links with a junction', () => {
  assert.match(ensurePs1, /\/api\/install\/node\?os=win32&arch=\$Arch/);
  assert.match(ensurePs1, /-Headers @\{ Authorization = "Bearer \$Key" \}/);
  assert.match(ensurePs1, /Get-OwnMindHeader -Response \$resp -Name 'X-Node-Version'/);
  assert.match(ensurePs1, /Get-OwnMindHeader -Response \$resp -Name 'X-Sha256'/);
  assert.match(ensurePs1, /Get-FileHash -LiteralPath \$File -Algorithm SHA256/);
  assert.match(ensurePs1, /SHASUMS256\.txt/);
  assert.match(ensurePs1, /\/index\.json/);
  assert.match(ensurePs1, /\$env:OWNMIND_NODE_DIST/);
  assert.match(ensurePs1, /\$env:OWNMIND_NODE_SOURCE/);
  assert.match(ensurePs1, /Expand-Archive -LiteralPath \$zip/);
  assert.match(ensurePs1, /New-Item -ItemType Junction -Path \$current -Value \$dest/);
  assert.doesNotMatch(code(ensurePs1), /SymbolicLink|mklink/, 'a symbolic link needs a privilege that a colleague\'s account lacks');
  // arch comes from the CPU, including a 32-bit PowerShell on a 64-bit Windows
  assert.match(ensurePs1, /\$env:PROCESSOR_ARCHITEW6432/);
  assert.match(ensurePs1, /if \(\$arch -eq 'AMD64'\) \{ return 'x64' \}/);
  assert.match(ensurePs1, /if \(\$arch -eq 'ARM64'\) \{ return 'arm64' \}/);
  // what the rest of the installer sees
  assert.match(ensurePs1, /\$env:OWNMIND_NODE = Join-Path \$current 'node\.exe'/);
  assert.match(ensurePs1, /\$env:OWNMIND_PRIVATE_NODE = '1'/);
  assert.match(ensurePs1, /\$env:Path = "\$current;\$env:Path"/);
  assert.match(ensurePs1, /'\.node-path'/);
  // the junction is made only after the unpack succeeded, and verified by running it
  assert.ok(ensurePs1.indexOf('Expand-Archive') < ensurePs1.indexOf('New-Item -ItemType Junction'));
  assert.match(ensurePs1, /if \(\$gotVer -ne \$version\)/);
  // the key is never sent to nodejs.org
  const nodejsFn = ensurePs1.slice(ensurePs1.indexOf('function Get-OwnMindNodeFromNodejs'), ensurePs1.indexOf('function Remove-OwnMindCurrent'));
  assert.doesNotMatch(nodejsFn, /Authorization/);
});

test('ensure-node-runtime.ps1 agrees with shared/node-runtime.js and the shell twin on naming and version', () => {
  // The PowerShell template and the shared helper must produce the same file name.
  assert.match(ensurePs1, /return "node-\$Version-win-\$Arch\.zip"/);
  for (const arch of ['x64', 'arm64']) {
    const fromPs = 'node-$Version-win-$Arch.zip'.replace('$Version', 'v22.11.0').replace('$Arch', arch);
    assert.equal(fromPs, nodeArchiveName({ os: 'win32', arch, version: 'v22.11.0' }));
  }
  assert.equal(Number(/OwnMindNodeLtsMajor = (\d+)/.exec(ensurePs1)[1]), NODE_LTS_MAJOR);
  assert.equal(Number(/OWNMIND_NODE_LTS_MAJOR=(\d+)/.exec(ensureSh)[1]), NODE_LTS_MAJOR);
  assert.equal(Number(/OwnMindNodeFloorMajor = (\d+)/.exec(ensurePs1)[1]), Number(/OWNMIND_NODE_FLOOR_MAJOR=(\d+)/.exec(ensureSh)[1]));
});

test('ensure-node-runtime.ps1 reuses fetch-release.ps1 and keeps strict mode out of the caller', () => {
  assert.match(ensurePs1, /^\. \(Join-Path \$PSScriptRoot 'fetch-release\.ps1'\)$/m);
  for (const src of [ensurePs1, read('scripts', 'install-helpers', 'fetch-release.ps1')]) {
    const topLevel = src.split('\n').filter((l) => /^Set-StrictMode/.test(l));
    assert.deepEqual(topLevel, [], 'a file-level Set-StrictMode would leak into install.ps1 when this file is dot-sourced');
  }
  assert.match(code(ensurePs1), /function Ensure-OwnMindNode \{[\s\S]*?Set-StrictMode -Version Latest/);
});
