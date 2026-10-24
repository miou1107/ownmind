import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bootstrap = readFileSync(join(__dirname, '..', 'scripts', 'bootstrap.sh'), 'utf8');
const fetchRelease = readFileSync(join(__dirname, '..', 'scripts', 'install-helpers', 'fetch-release.sh'), 'utf8');
const preflight = readFileSync(join(__dirname, '..', 'scripts', 'install-helpers', 'preflight.sh'), 'utf8');

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
    'bootstrap.sh must not exit when git is missing; it installs from the release archive instead');
  assert.doesNotMatch(bootstrap, /command -v git[^\n]*\n[^\n]*\n[^\n]*exit 1/,
    'no unconditional exit 1 right after the git check');
  assert.match(bootstrap, /log_info archive_mode "git is not installed; installing from the release archive"/);
});

test('the git path is still there, unchanged in shape', () => {
  assert.match(bootstrap, /git\s+clone\s+"\$OWNMIND_REPO"\s+"\$OWNMIND_DIR"/);
  assert.match(bootstrap, /\.broken\./);
  assert.match(bootstrap, /interactive-upgrade\.sh/);
});

test('archive layout and failure lines are named as the contract says', () => {
  for (const needle of ['.release', '.ownmind.partial', 'FIX:use_fallback_source', 'FIX:clear_partial',
    'ASK:no_network', 'fallback_source', 'clear_partial', 'OWNMIND_SOURCE']) {
    assert.ok(bootstrap.includes(needle), `bootstrap.sh should mention ${needle}`);
  }
  assert.match(bootstrap, /ASK:no_network:The installer could not reach the OwnMind server or GitHub\. Check that this computer is online, then paste the same install message to the AI again\./);
  assert.match(bootstrap, /FIX:use_fallback_source:\$\(ownmind_retry_cmd "OWNMIND_SOURCE=github "\)/);
  assert.match(bootstrap, /FIX:clear_partial:rm -rf ~\/\.ownmind\.partial/);
  assert.match(bootstrap, /log_ok unpack "release \$release unpacked"/);
});

test('the download uses retry, a connect timeout, and keeps the key off the command line', () => {
  const block = embeddedBlock(bootstrap, 'fetch-release');
  assert.match(block, /OWNMIND_CURL_FLAGS="--retry 3 --connect-timeout 15 --speed-limit 1024 --speed-time 60"/);
  assert.match(block, /ownmind_curl_auth "\$key" \| curl -K -/,
    'the Authorization header must be fed to curl on stdin, not as a -H argument');
  assert.doesNotMatch(block, /-H\s+"Authorization/,
    'a -H Authorization argument would show the key in ps');
  assert.match(block, /\/api\/install\/archive/);
  assert.match(block, /https:\/\/api\.github\.com/);
  assert.match(block, /\/repos\/miou1107\/ownmind\/tags\?per_page=30/);
  assert.match(block, /codeload\.github\.com/);
  assert.match(block, /tar -xzf/);
});

test('the key is never sent to GitHub', () => {
  const block = embeddedBlock(bootstrap, 'fetch-release');
  const githubPart = block.slice(block.indexOf('ownmind_github_latest_tag'));
  const afterServer = githubPart.slice(githubPart.indexOf('tag=$(ownmind_github_latest_tag)'));
  assert.doesNotMatch(afterServer, /ownmind_curl_auth/);
});

test('the embedded download and unpack functions are byte-identical to fetch-release.sh', () => {
  assert.equal(embeddedBlock(bootstrap, 'fetch-release'), embeddedBlock(fetchRelease, 'fetch-release'),
    'edit scripts/install-helpers/fetch-release.sh, then paste the block between the markers into bootstrap.sh');
  const block = embeddedBlock(fetchRelease, 'fetch-release');
  assert.match(block, /^ownmind_download_archive\(\)/m);
  assert.match(block, /^ownmind_unpack_release\(\)/m);
});

test('an existing directory with .release and no .git is a healthy archive install', () => {
  const branch = bootstrap.slice(bootstrap.indexOf('# Branch 2:'));
  assert.match(branch, /-f "\$OWNMIND_DIR\/\.release"/);
  // a later task adds an archive branch to the upgrader and marks it with this literal
  assert.match(branch, /grep -q 'ARCHIVE_MODE' "\$OWNMIND_DIR\/scripts\/interactive-upgrade\.sh"/);
  assert.match(branch, /log_info already_installed "archive install found; re-running install\.sh"/);
  assert.ok(branch.indexOf('.release') < branch.indexOf('.broken.'),
    'the .release check must come before the backup of a broken directory');
});

test('after unpack and before install.sh there is a guarded hook for the private Node runtime', () => {
  assert.match(bootstrap,
    /if \[ -f "\$OWNMIND_DIR\/scripts\/install-helpers\/ensure-node-runtime\.sh" \]; then\n\s+\. "\$OWNMIND_DIR\/scripts\/install-helpers\/ensure-node-runtime\.sh"\n\s+ownmind_ensure_node "\$\{api%\/\}" "\$key" \|\| exit 1\n\s+fi/);
  const fn = bootstrap.slice(bootstrap.indexOf('install_from_archive() {'));
  assert.ok(fn.indexOf('ensure-node-runtime.sh') < fn.indexOf('bash install.sh'));
  assert.doesNotMatch(bootstrap, /nodejs\.org/, 'installing Node is a later step, not this one');
});

test('bash 3.2 (stock macOS) compatibility: none of the newer bash features', () => {
  for (const src of [bootstrap, fetchRelease]) {
    assert.doesNotMatch(src, /\bmapfile\b|\breadarray\b/);
    assert.doesNotMatch(src, /\$\{[A-Za-z_]+(,,|\^\^)\}/);
    assert.doesNotMatch(src, /declare -A/);
  }
});

test('--retry-all-errors is only passed to a curl that knows it (macOS 11 has 7.64)', () => {
  const block = embeddedBlock(bootstrap, 'fetch-release');
  assert.match(block, /OWNMIND_CURL_HELP=\$\(curl --help all/, 'the flag must be probed from curl\'s own help');
  assert.match(block, /\*--retry-all-errors\*\) OWNMIND_CURL_FLAGS="\$OWNMIND_CURL_FLAGS --retry-all-errors"/);
  const withoutProbe = block.replace(/\*--retry-all-errors\*\)[^\n]*\n/, '').replace(/case "\$OWNMIND_CURL_HELP"/, '');
  const unconditional = withoutProbe.split('\n').filter((l) => !l.trim().startsWith('#') && l.includes('--retry-all-errors'));
  assert.deepEqual(unconditional, [], 'every other use of the flag would be unconditional');
  assert.doesNotMatch(block, /curl --help all[^\n]*\|\s*grep/, 'piping into grep -q can fail under pipefail');
  // printf lines only print the retry command for the AI; they do not run curl.
  const calls = block.split('\n').filter((l) => !/^\s*printf\b/.test(l) && (/\bcurl\b[^\n]*-fsSL/.test(l) || /^\s+\$?\s*curl -fsSL/.test(l)));
  assert.ok(calls.length >= 3);
  for (const l of calls) assert.match(l, /\$OWNMIND_CURL_FLAGS/, `curl call without the shared flags: ${l}`);
});

test('HAS_GIT is decided by ownmind_git_usable, not by command -v git (macOS ships a git stub)', () => {
  assert.match(bootstrap, /^HAS_GIT=1\nownmind_git_usable \|\| HAS_GIT=0$/m);
  assert.doesNotMatch(bootstrap, /command -v git[^\n]*HAS_GIT/);
  assert.match(preflight, /if ! ownmind_git_usable; then\n\s+printf 'git\\t/,
    'preflight.sh must use the same check wherever it decides git is missing');
  assert.doesNotMatch(preflight.replace(embeddedBlock(preflight, 'git-usable'), ''), /command -v git/);
  assert.match(embeddedBlock(preflight, 'git-usable'), /OWNMIND_XCODE_SELECT:-\/usr\/bin\/xcode-select/);
});

test('the embedded git check is byte-identical to preflight.sh', () => {
  assert.equal(embeddedBlock(bootstrap, 'git-usable'), embeddedBlock(preflight, 'git-usable'),
    'edit scripts/install-helpers/preflight.sh, then paste the block between the markers into bootstrap.sh');
});

test('a failed download removes the empty partial directory; a healthy archive install needs install.sh', () => {
  assert.match(bootstrap, /ownmind_download_archive "\$key" "\$api" "\$partial\/archive\.tar\.gz" \|\| \{ rm -rf "\$partial"; exit 1; \}/);
  assert.match(bootstrap, /-f "\$OWNMIND_DIR\/\.release" \] \|\| \[ -f "\$OWNMIND_DIR\/\.swap-journal\.json" \]; \} && \[ -f "\$OWNMIND_DIR\/install\.sh" \]/);
});
