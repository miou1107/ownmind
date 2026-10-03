/**
 * The API key sits in plain text in each AI tool's config file. Every writer saved through a
 * fresh temporary file, which takes the umask (022 on a normal Mac or Linux account), so the
 * file came out 0644: readable by every other account on a shared machine.
 *
 * The permission assertions are POSIX-only; Windows has no group/other bits for Node to set,
 * and a user's home folder is private there by default.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const require_ = createRequire(import.meta.url);
const { secureKeyFiles } = require_('../scripts/install-helpers/secure-key-files.cjs');
const { registerMcp } = require_('../scripts/install-helpers/register-mcp.cjs');
const { ensureKeyFile } = require_('../scripts/install-helpers/ensure-key-file.cjs');

const POSIX = { skip: process.platform === 'win32' ? 'no POSIX permission bits on Windows' : false };
const KEY = '11111111-1111-4111-8111-111111111111';
const withKey = { mcpServers: { ownmind: { env: { OWNMIND_API_URL: 'https://example.invalid', OWNMIND_API_KEY: KEY } } } };
const perms = (p) => fs.statSync(p).mode & 0o777;

function put(home, rel, content, mode = 0o644) {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  fs.chmodSync(p, mode);
  return p;
}

describe('fresh writes of a key-holding config are owner-only', () => {
  let oldMask;
  before(() => { oldMask = process.umask(0o022); });
  after(() => { process.umask(oldMask); });

  it('registerMcp writes ~/.claude.json as 0600, not 0644', POSIX, () => {
    const home = tempDir('ownmind-perm-');
    registerMcp({ entry: { command: 'node', args: ['x'] }, apiUrl: 'https://example.invalid', apiKey: KEY, home });
    assert.equal(perms(path.join(home, '.claude.json')).toString(8), '600');
  });

  it('registerMcp makes an existing world-readable ~/.claude.json owner-only', POSIX, () => {
    const home = tempDir('ownmind-perm-');
    put(home, '.claude.json', { projects: {} }, 0o644);
    registerMcp({ entry: { command: 'node', args: ['x'] }, apiUrl: 'https://example.invalid', apiKey: KEY, home });
    assert.equal(perms(path.join(home, '.claude.json')).toString(8), '600');
  });

  it('ensureKeyFile writes settings.json as 0600 when it copies the key in', POSIX, () => {
    const home = tempDir('ownmind-perm-');
    const r = ensureKeyFile({ home, env: { OWNMIND_API_KEY: KEY, OWNMIND_API_URL: 'https://example.invalid' } });
    assert.equal(r.outcome, 'repaired');
    assert.equal(perms(path.join(home, '.claude', 'settings.json')).toString(8), '600');
  });
});

describe('secureKeyFiles: the sweep run by install and every auto-update', () => {
  // The sweep honours CODEX_HOME; a runner that sets it must not move Codex out of the sandbox.
  let savedCodexHome;
  before(() => { savedCodexHome = process.env.CODEX_HOME; delete process.env.CODEX_HOME; });
  after(() => { if (savedCodexHome !== undefined) process.env.CODEX_HOME = savedCodexHome; });

  it('also restricts backups and leftover temporary copies, which hold the key too', POSIX, () => {
    const home = tempDir('ownmind-perm-');
    const copies = [
      put(home, '.claude/settings.json.bak.1759480000000', withKey),
      put(home, '.claude/settings.json.tmp', withKey),
      put(home, '.claude.json.ownmind.tmp', withKey),
      put(home, '.claude.json.backup', withKey),
      put(home, '.claude/backups/.claude.json.backup.1759480000000', withKey),
    ];
    const unrelated = put(home, '.claude/other.json', withKey);
    secureKeyFiles({ home });
    for (const f of copies) assert.equal(perms(f).toString(8), '600', f);
    assert.equal(perms(unrelated).toString(8), '644', 'only copies of the known configs');
  });

  it('reports a config it cannot reach instead of skipping it silently', {
    skip: POSIX.skip || (process.getuid?.() === 0 ? 'root can read anything' : false),
  }, () => {
    const home = tempDir('ownmind-perm-');
    put(home, '.cursor/mcp.json', withKey);
    fs.chmodSync(path.join(home, '.cursor'), 0o000);
    try {
      const r = secureKeyFiles({ home });
      assert.ok(r.files.some((f) => f.error && f.path.includes('.cursor')), JSON.stringify(r));
    } finally {
      fs.chmodSync(path.join(home, '.cursor'), 0o755);
    }
  });

  it('takes group and other access away from every config holding the key', POSIX, () => {
    const home = tempDir('ownmind-perm-');
    const files = [
      put(home, '.claude.json', withKey),
      put(home, '.claude/settings.json', withKey, 0o664),
      put(home, '.cursor/mcp.json', withKey, 0o666),
      put(home, '.codex/config.toml', '[mcp_servers.ownmind.env]\nOWNMIND_API_KEY = "x"\n', 0o640),
    ];
    const r = secureKeyFiles({ home });
    assert.equal(r.files.filter((f) => !f.error).length, 4);
    for (const f of files) assert.equal(perms(f).toString(8), '600', f);
  });

  it('leaves the owner bits alone: an executable or read-only file stays so', POSIX, () => {
    const home = tempDir('ownmind-perm-');
    const p = put(home, '.claude.json', withKey, 0o444);
    secureKeyFiles({ home });
    assert.equal(perms(p).toString(8), '400');
  });

  it('does not touch a config without the key, or one already private', POSIX, () => {
    const home = tempDir('ownmind-perm-');
    const noKey = put(home, '.cursor/mcp.json', { mcpServers: { other: {} } }, 0o644);
    const priv = put(home, '.claude.json', withKey, 0o600);
    const r = secureKeyFiles({ home });
    assert.deepEqual(r.files, []);
    assert.equal(perms(noKey).toString(8), '644');
    assert.equal(perms(priv).toString(8), '600');
  });

  it('does not touch a file owned by someone else', POSIX, () => {
    const home = tempDir('ownmind-perm-');
    const p = put(home, '.claude.json', withKey, 0o644);
    const r = secureKeyFiles({ home, uid: fs.statSync(p).uid + 1 });
    assert.deepEqual(r.files, []);
    assert.equal(perms(p).toString(8), '644');
  });

  it('restricts the real file behind a symlink (dotfile managers link these)', POSIX, () => {
    const home = tempDir('ownmind-perm-');
    const real = put(home, 'dotfiles/claude.json', withKey, 0o644);
    fs.symlinkSync(real, path.join(home, '.claude.json'));
    secureKeyFiles({ home });
    assert.equal(perms(real).toString(8), '600');
  });

  it('changes permissions only, never content', POSIX, () => {
    const home = tempDir('ownmind-perm-');
    const p = put(home, '.claude.json', withKey, 0o644);
    const beforeText = fs.readFileSync(p, 'utf8');
    secureKeyFiles({ home });
    assert.equal(fs.readFileSync(p, 'utf8'), beforeText);
  });

  it('does nothing on Windows', () => {
    const home = tempDir('ownmind-perm-');
    put(home, '.claude.json', withKey);
    assert.deepEqual(secureKeyFiles({ home, platform: 'win32' }), { skipped: 'windows', files: [] });
  });

  it('never prints the key', () => {
    const home = tempDir('ownmind-perm-');
    put(home, '.claude.json', withKey);
    const out = JSON.stringify(secureKeyFiles({ home }));
    assert.ok(!out.includes(KEY));
  });
});

describe('install and auto-update run the sweep', () => {
  const read = (rel) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');
  it('install.sh runs it, without letting a failure stop the install', () => {
    assert.match(read('install.sh'), /secure-key-files\.cjs" \|\| true/);
  });
  it('install.sh runs it before the artifact check, whose failure exits early', () => {
    const s = read('install.sh');
    const sweep = s.indexOf('secure-key-files.cjs" || true');
    const check = s.indexOf('if [ -f "$ARTIFACT_CHECK" ]');
    assert.ok(sweep > 0 && check > sweep, `sweep at ${sweep}, artifact check at ${check}`);
  });
  it('update.sh runs it, without letting a failure stop the update', () => {
    assert.match(read('scripts/update.sh'), /node "\$SECURE_KEYS"[^\n]*\|\| true/);
  });
});
