import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HELPER = new URL('../scripts/install-helpers/install-artifacts.cjs', import.meta.url).pathname;
const { ARTIFACTS, checkInstallArtifacts } = require('../scripts/install-helpers/install-artifacts.cjs');

/**
 * Bug report #15: install.sh aborted before it produced any of these, and the machine
 * afterwards reported the current version because something else had moved the working
 * tree forward. Nothing looked at whether the parts existed.
 */

/** Build a home directory holding every artifact, then optionally remove some. */
function makeHome(omit = []) {
  const home = mkdtempSync(join(tmpdir(), 'ownmind-artifacts-'));
  const ownmindDir = join(home, '.ownmind');
  const ctx = { home, ownmindDir };
  for (const artifact of ARTIFACTS) {
    if (omit.includes(artifact.id)) continue;
    const target = artifact.locate(ctx);
    if (artifact.kind === 'dir') {
      mkdirSync(target, { recursive: true });
    } else {
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, '');
    }
  }
  return { home, ownmindDir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('checkInstallArtifacts', () => {
  it('passes when every artifact is present', () => {
    const h = makeHome();
    try {
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      assert.equal(r.ok, true);
      assert.equal(r.missing.length, 0);
      assert.equal(r.checked, ARTIFACTS.length);
    } finally { h.cleanup(); }
  });

  it('names the SessionStart hook when it is the one missing', () => {
    const h = makeHome(['session_start_hook']);
    try {
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      assert.equal(r.ok, false);
      assert.equal(r.missing.length, 1);
      assert.equal(r.missing[0].id, 'session_start_hook');
      // The message has to say what the user loses, not just a filename.
      assert.match(r.missing[0].describe, /memories/);
    } finally { h.cleanup(); }
  });

  it('reports every artifact an aborted install never reached, not just the first', () => {
    // The real shape of bug #15: install.sh stopped partway, so several are gone at once.
    const h = makeHome(['session_start_hook', 'iron_rule_hook', 'hook_lib']);
    try {
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      assert.equal(r.missing.length, 3);
    } finally { h.cleanup(); }
  });

  it('does not accept a file where a directory is required', () => {
    const h = makeHome(['hook_lib']);
    try {
      const asFile = ARTIFACTS.find((a) => a.id === 'hook_lib')
        .locate({ home: h.home, ownmindDir: h.ownmindDir });
      mkdirSync(join(asFile, '..'), { recursive: true });
      writeFileSync(asFile, 'not a directory');
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      assert.equal(r.ok, false, 'a plain file must not satisfy a directory artifact');
    } finally { h.cleanup(); }
  });

  it('fails closed when a path cannot be stat-ed', function (t) {
    if (process.getuid && process.getuid() === 0) return t.skip('root ignores mode bits');
    const h = makeHome();
    try {
      // Make ~/.claude/hooks unreadable so statSync throws EACCES rather than ENOENT.
      const hooks = join(h.home, '.claude', 'hooks');
      chmodSync(hooks, 0o000);
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      chmodSync(hooks, 0o755);
      assert.equal(r.ok, false, 'an unreadable path counts as missing, never as present');
    } finally {
      try { chmodSync(join(h.home, '.claude', 'hooks'), 0o755); } catch { /* already restored */ }
      h.cleanup();
    }
  });
});

describe('install-artifacts CLI (this is what install.sh calls)', () => {
  it('exits 0 and says so when complete', () => {
    const h = makeHome();
    try {
      const out = execFileSync(process.execPath, [HELPER, '--ownmind-dir', h.ownmindDir],
        { encoding: 'utf8', env: { ...process.env, HOME: h.home } });
      assert.match(out, /install complete/);
    } finally { h.cleanup(); }
  });

  it('exits non-zero and names what is missing', () => {
    const h = makeHome(['session_start_hook']);
    try {
      let code = 0;
      let stderr = '';
      try {
        execFileSync(process.execPath, [HELPER, '--ownmind-dir', h.ownmindDir],
          { encoding: 'utf8', env: { ...process.env, HOME: h.home }, stdio: 'pipe' });
      } catch (err) {
        code = err.status;
        stderr = err.stderr;
      }
      assert.equal(code, 1, 'install.sh keys off the exit code');
      assert.match(stderr, /INCOMPLETE/);
      assert.match(stderr, /memories/);
    } finally { h.cleanup(); }
  });
});

describe('the artifact list has exactly one home', () => {
  it('self-check.cjs derives its item from the shared module', () => {
    const src = require('node:fs')
      .readFileSync(new URL('../scripts/install-helpers/self-check.cjs', import.meta.url), 'utf8');
    assert.match(src, /require\('\.\/install-artifacts\.cjs'\)/,
      'self-check must call the shared checker, not keep a second list');
    assert.doesNotMatch(src, /ownmind-session-start\.sh['"]\s*\)?\s*;?\s*\/\/\s*artifact/,
      'no parallel artifact list in self-check');
  });

  it('install.sh calls the CLI rather than testing paths itself', () => {
    const src = require('node:fs')
      .readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
    assert.match(src, /install-artifacts\.cjs/);
    assert.match(src, /\[FAIL\] Installation did not complete/);
  });
});
