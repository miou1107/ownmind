import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Static checks for the Windows side of the archive-mode bootstrap (bootstrap.ps1).
 *
 * These read the scripts as text, and text is all they prove: this suite runs on machines with
 * no PowerShell. The behaviour itself runs on the Windows leg of CI, in
 * tests/bootstrap-archive-mode-ps1.e2e.mjs. The assertions mirror tests/bootstrap-archive-mode.test.js
 * (the bash twin) so that one side cannot drift from the other without a red test.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The working tree carries CRLF for .ps1 files (see .gitattributes); the index and the embedded
// copies are compared line-ending-neutral.
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const readRaw = (...parts) => readFileSync(join(root, ...parts));

const bootstrap = read('scripts', 'bootstrap.ps1');
const fetchRelease = read('scripts', 'install-helpers', 'fetch-release.ps1');
const bootstrapSh = read('scripts', 'bootstrap.sh');
const fetchReleaseSh = read('scripts', 'install-helpers', 'fetch-release.sh');

/** The text between the BEGIN/END markers, markers included. */
function embeddedBlock(src, name) {
  const begin = src.indexOf(`# BEGIN ${name}`);
  const endMarker = `# END ${name}`;
  const end = src.indexOf(endMarker);
  assert.ok(begin >= 0 && end > begin, `expected "# BEGIN ${name}" ... "${endMarker}" markers`);
  return src.slice(begin, end + endMarker.length);
}

test('a machine without git is no longer turned away', () => {
  assert.doesNotMatch(bootstrap, /preflight_missing_git/,
    'bootstrap.ps1 must not exit when git is missing; it installs from the release archive instead');
  assert.doesNotMatch(bootstrap, /git is not on PATH/);
  assert.match(bootstrap, /Log-Info archive_mode "git is not installed; installing from the release archive"/);
  // Same lookup as before: a profile alias named git is not a program these scripts can run.
  assert.match(bootstrap, /\$gitCmd = Get-Command git -CommandType Application -ErrorAction SilentlyContinue\n\$HasGit = \(\$null -ne \$gitCmd\)/);
  assert.match(bootstrap, /if \(-not \$HasGit\) \{\n\s+Install-FromArchive \$InstallArgs\n\s+exit 0/);
});

test('the git path is still there, unchanged in shape', () => {
  assert.match(bootstrap, /git clone "\$Repo" "\$OwnmindDir"/);
  assert.match(bootstrap, /\.broken\./);
  assert.match(bootstrap, /interactive-upgrade\.ps1/);
  assert.match(bootstrap, /Log-Info fresh "Fresh install: cloning repo"/);
});

test('archive layout and failure lines are named as the contract says', () => {
  for (const needle of ['.release', '.ownmind.partial', 'FIX:use_fallback_source', 'FIX:clear_partial',
    'ASK:no_network', 'fallback_source', 'clear_partial', 'OWNMIND_SOURCE', 'OWNMIND_GITHUB_API', 'OWNMIND_GITHUB_CODELOAD']) {
    assert.ok(bootstrap.includes(needle), `bootstrap.ps1 should mention ${needle}`);
  }
  assert.match(bootstrap, /Log-Ok unpack "release \$name unpacked"/);
});

test('the sentences the person reads are byte-identical to the shell side', () => {
  // The ASK sentence is what the AI reads out to a colleague; it must not differ by platform.
  const ask = /ASK:no_network:[^"\n]*\./.exec(bootstrapSh);
  assert.ok(ask, 'bootstrap.sh no longer carries the ASK:no_network sentence');
  const fetchAsk = /ASK:no_network:[^"\n]*\./.exec(fetchReleaseSh);
  assert.equal(fetchAsk[0], ask[0]);
  const block = embeddedBlock(bootstrap, 'fetch-release');
  const occurrences = block.split(ask[0]).length - 1;
  assert.equal(occurrences, 2, 'both failure paths (server forced, and both sources failed) print the same ASK sentence');
  // The FIX codes are the same; the command is the PowerShell spelling of the shell one.
  assert.match(bootstrapSh, /FIX:use_fallback_source:OWNMIND_SOURCE=github bash <same one-liner>/);
  assert.match(block, /FIX:use_fallback_source:`\$env:OWNMIND_SOURCE='github'; <same one-liner>/);
  assert.match(bootstrapSh, /FIX:clear_partial:rm -rf ~\/\.ownmind\.partial/);
  assert.match(bootstrap, /FIX:clear_partial:Remove-Item -Recurse -Force "\$env:USERPROFILE\\\.ownmind\.partial"/);
  // The other ERROR / INFO sentences.
  for (const sentence of [
    'Could not download the release archive from the OwnMind server or GitHub',
    'The OwnMind server did not deliver the archive; trying GitHub',
    'GitHub tag list unavailable; using the main branch',
    'Could not unpack the archive (it may be damaged)',
    'Removing the unfinished download from an earlier attempt',
  ]) {
    assert.ok(fetchReleaseSh.includes(sentence) || bootstrapSh.includes(sentence), `${sentence} is not on the shell side`);
    assert.ok(bootstrap.includes(sentence), `${sentence} is missing on the Windows side`);
  }
  assert.match(bootstrap, /git is not installed; installing from the release archive/);
});

test('the download uses retry, a TLS 1.2 opt-in, in-process headers, and never sends the key to GitHub', () => {
  const block = embeddedBlock(bootstrap, 'fetch-release');
  assert.match(block, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/);
  assert.match(block, /Start-Sleep -Seconds \$attempt/);
  assert.match(block, /Invoke-WebRequest -Uri \$Uri -OutFile \$Dest -Headers \$Headers -UseBasicParsing/);
  assert.match(block, /-Headers @\{ Authorization = "Bearer \$Key" \}/);
  assert.match(block, /SecurityProtocolType\]::Tls12/);
  assert.match(block, /\$ProgressPreference = 'SilentlyContinue'/);
  assert.match(block, /\/api\/install\/archive\?format=zip/);
  assert.match(block, /https:\/\/api\.github\.com/);
  assert.match(block, /\/repos\/miou1107\/ownmind\/tags\?per_page=30/);
  assert.match(block, /\$ghBase\/miou1107\/ownmind\/archive\/\$ref\.zip/);
  assert.match(block, /Expand-Archive -LiteralPath \$Archive/);
  assert.doesNotMatch(block, /\bcurl\b/, 'Windows PowerShell has no curl; the key would also land on a command line');
  assert.doesNotMatch(block, /-Headers[^\n]*-Uri|--header|-H\s+"Authorization/);
  // The key stays off the GitHub requests: everything after the server attempt has no Authorization.
  const afterServer = block.slice(block.indexOf('$tag = Get-OwnMindGithubLatestTag'));
  assert.doesNotMatch(afterServer, /Authorization/);
  const tagFn = block.slice(block.indexOf('function Get-OwnMindGithubLatestTag'), block.indexOf('function Get-OwnMindArchive'));
  assert.doesNotMatch(tagFn, /Authorization/);
  assert.match(tagFn, /\$best -or \$v -gt \$best|\$null -eq \$best -or \$v -gt \$best/, 'the newest tag is chosen by comparing versions, not strings');
});

test('the embedded download and unpack functions are byte-identical to fetch-release.ps1', () => {
  assert.equal(embeddedBlock(bootstrap, 'fetch-release'), embeddedBlock(fetchRelease, 'fetch-release'),
    'edit scripts/install-helpers/fetch-release.ps1, then paste the block between the markers into bootstrap.ps1');
  const block = embeddedBlock(fetchRelease, 'fetch-release');
  assert.match(block, /^function Get-OwnMindArchive \{/m);
  assert.match(block, /^function Expand-OwnMindRelease \{/m);
  assert.match(block, /^function Invoke-OwnMindDownload \{/m);
});

test('an existing directory with .release and no .git is a healthy archive install', () => {
  const branch = bootstrap.slice(bootstrap.indexOf('# Branch 2:'));
  assert.match(branch, /Test-Path -LiteralPath "\$OwnmindDir\\\.release"/);
  assert.match(branch, /Test-Path -LiteralPath "\$OwnmindDir\\install\.ps1"/);
  // a later task adds an archive branch to the upgrader and marks it with this literal
  assert.match(branch, /Select-String -LiteralPath \$upgrader -Pattern 'ARCHIVE_MODE' -SimpleMatch -Quiet/);
  assert.match(branch, /Log-Info already_installed "archive install found; re-running install\.ps1"/);
  assert.ok(branch.indexOf('.release') < branch.indexOf('.broken.'),
    'the .release check must come before the backup of a broken directory');
  assert.ok(branch.indexOf('already_installed') < branch.indexOf('.broken.'));
});

test('after unpack and before install.ps1 there is a guarded hook for the private Node runtime', () => {
  assert.match(bootstrap,
    /\$nodeHelper = Join-Path \$OwnmindDir 'scripts\\install-helpers\\ensure-node-runtime\.ps1'\n\s+if \(Test-Path -LiteralPath \$nodeHelper\) \{\n\s+\. \$nodeHelper\n\s+\$nodeOk = @\(Ensure-OwnMindNode -ApiUrl \$api\.TrimEnd\('\/'\) -ApiKey \$key\) \| Select-Object -Last 1\n\s+if \(-not \$nodeOk\) \{ exit 1 \}\n\s+\}/);
  const fn = bootstrap.slice(bootstrap.indexOf('function Install-FromArchive {'));
  assert.ok(fn.indexOf('ensure-node-runtime.ps1') < fn.indexOf('-File .\\install.ps1'));
  const code = bootstrap.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /nodejs\.org/, 'installing Node is the helper\'s job, not bootstrap\'s');
});

test('a failed download removes the partial directory; unpack goes through unpack then a move', () => {
  assert.match(bootstrap, /\$dl = @\(Get-OwnMindArchive -Key \$key -Api \$api -Dest \(Join-Path \$partial 'archive\.zip'\)\) \| Select-Object -Last 1\n\s+if \(\$null -eq \$dl\) \{\n\s+Remove-Item -LiteralPath \$partial -Recurse -Force -ErrorAction SilentlyContinue\n\s+exit 1/);
  const unpack = embeddedBlock(bootstrap, 'fetch-release');
  assert.match(unpack, /\$unpack = Join-Path \$Partial 'unpack'/);
  assert.match(unpack, /Move-Item -LiteralPath \$root -Destination \$Final/);
  assert.ok(unpack.indexOf('Expand-Archive') < unpack.indexOf('Move-Item'), 'nothing is moved into place before the unpack finished');
  assert.match(unpack, /The archive is missing \.release or install\.ps1/);
  assert.match(unpack, /\[System\.IO\.File\]::WriteAllText\(\(Join-Path \$root '\.release'\)/);
});

test('without a key the script says what is needed instead of downloading', () => {
  assert.match(bootstrap, /Log-Err missing_args "The API key and URL are needed to install OwnMind/);
  const fn = bootstrap.slice(bootstrap.indexOf('function Install-FromArchive {'));
  assert.ok(fn.indexOf('missing_args') < fn.indexOf('Get-OwnMindArchive'));
  // The same two inputs install.ps1 reads.
  assert.match(fn, /\$env:OWNMIND_API_KEY/);
  assert.match(fn, /\$env:OWNMIND_API_URL/);
});

test('Windows PowerShell 5.1 compatibility: none of the newer language features', () => {
  for (const [name, src] of [['bootstrap.ps1', bootstrap], ['fetch-release.ps1', fetchRelease]]) {
    const code = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(code, /\?\?/, `${name}: null-coalescing needs PowerShell 7`);
    assert.doesNotMatch(code, /\s\?\s[^\n]*\s:\s/, `${name}: the ternary operator needs PowerShell 7`);
    assert.doesNotMatch(code, /-Parallel/, `${name}: ForEach-Object -Parallel needs PowerShell 7`);
    assert.doesNotMatch(code, /\)\s*(&&|\|\|)\s/, `${name}: pipeline chain operators need PowerShell 7`);
    assert.doesNotMatch(code, /\bInvoke-WebRequest\b[^\n]*-SkipCertificateCheck/);
  }
});

test('the new .ps1 files are plain ASCII without a byte order mark', () => {
  for (const rel of [
    ['scripts', 'bootstrap.ps1'],
    ['scripts', 'install-helpers', 'fetch-release.ps1'],
    ['scripts', 'install-helpers', 'ensure-node-runtime.ps1'],
  ]) {
    const bytes = readRaw(...rel);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${rel.join('/')} must not start with a byte order mark`);
    assert.ok(bytes.every((b) => b < 0x80), `${rel.join('/')} must be pure ASCII: Windows PowerShell 5.1 reads a BOM-less file in the system code page`);
  }
});
