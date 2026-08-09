import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// v1.26.106 — fileURLToPath, not .pathname. On Windows a file: URL pathname is
// '/C:/Users/...'; node then resolves that against the current drive root and looks for
// 'C:C:Users...'. This file threw MODULE_NOT_FOUND / ENOENT on every Windows run while
// passing on macOS, where the pathname happens to be a valid path.
const HELPER = fileURLToPath(new URL('../scripts/install-helpers/install-artifacts.cjs', import.meta.url));
const { ARTIFACTS, checkInstallArtifacts } = require('../scripts/install-helpers/install-artifacts.cjs');

/**
 * Bug report #15: install.sh aborted before it produced any of these, and the machine
 * afterwards reported the current version because something else had moved the working
 * tree forward. Nothing looked at whether the parts existed.
 */

const touch = (p) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, ''); };

/**
 * Build a home directory holding every artifact, satisfying each by its FIRST candidate
 * path unless told otherwise.
 */
function makeHome({ omit = [], satisfyWith = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ownmind-artifacts-'));
  const ownmindDir = join(home, '.ownmind');
  const ctx = { home, ownmindDir };
  // The bash SessionStart hook must exist before `hook_lib`'s `applies` is consulted, so
  // create everything up front and let `applies` do its own filtering afterwards.
  for (const artifact of ARTIFACTS) {
    if (omit.includes(artifact.id)) continue;
    const candidates = artifact.locate(ctx);
    const chosen = candidates[satisfyWith[artifact.id] ?? 0];
    if (artifact.kind === 'dir') mkdirSync(chosen, { recursive: true });
    else touch(chosen);
  }
  return { home, ownmindDir, ctx, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('checkInstallArtifacts', () => {
  it('passes when every artifact is present', () => {
    const h = makeHome();
    try {
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      assert.equal(r.ok, true, JSON.stringify(r.missing));
      assert.equal(r.checked, ARTIFACTS.length);
    } finally { h.cleanup(); }
  });

  it('names the SessionStart hook when it is the one missing', () => {
    const h = makeHome({ omit: ['session_start_hook'] });
    try {
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      assert.equal(r.ok, false);
      assert.ok(r.missing.some((m) => m.id === 'session_start_hook'));
      // The message has to say what the user loses, not just a filename.
      assert.match(r.missing.find((m) => m.id === 'session_start_hook').describe, /memories/);
    } finally { h.cleanup(); }
  });

  it('reports every artifact an aborted install never reached, not just the first', () => {
    // The real shape of bug #15: install.sh stopped partway, so several are gone at once.
    const h = makeHome({ omit: ['session_start_hook', 'iron_rule_hook', 'git_hooks'] });
    try {
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      // hook_lib drops out too: its `applies` sees no bash SessionStart hook.
      assert.deepEqual(
        r.missing.map((m) => m.id).sort(),
        ['git_hooks', 'iron_rule_hook', 'session_start_hook']
      );
    } finally { h.cleanup(); }
  });

  // v1.26.106 — this used chmod(0o000) on the hooks directory, which is a no-op on Windows:
  // NTFS does not honour POSIX mode bits, statSync kept succeeding, and the test failed on
  // the platform it was meant to protect while passing on macOS.
  //
  // Replacing the directory with a file makes the stat fail for a reason every platform
  // agrees on — ENOTDIR when resolving a child of a non-directory — so the assertion is now
  // about the code under test rather than about the host's permission model. It also removes
  // the root special-case: root ignores mode bits, but not this.
  it('fails closed when a path cannot be stat-ed', () => {
    const h = makeHome();
    const hooks = join(h.home, '.claude', 'hooks');
    try {
      rmSync(hooks, { recursive: true, force: true });
      writeFileSync(hooks, 'not a directory');
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      assert.equal(r.ok, false, 'an unreadable path counts as missing, never as present');
      assert.ok(r.missing.some((m) => m.id === 'iron_rule_hook'),
        'the artifact whose path became unreadable must be the one reported missing');
    } finally {
      h.cleanup();
    }
  });
});

describe('the two Windows installers produce different files, and both must pass', () => {
  // install.ps1 registers the Node hooks; Git Bash install.sh registers the .sh ones.
  // Naming only one implementation would report a healthy install.ps1 machine as broken —
  // and this check feeds the alerting, so a false fail is a broadcast telling somebody to
  // re-run an installer that will not change anything.
  it('accepts the Node SessionStart hook in ~/.ownmind/hooks', () => {
    const h = makeHome({ satisfyWith: { session_start_hook: 2 } });
    try {
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      assert.equal(r.ok, true, JSON.stringify(r.missing));
    } finally { h.cleanup(); }
  });

  it('accepts the Node iron-rule hook', () => {
    const h = makeHome({ satisfyWith: { iron_rule_hook: 1 } });
    try {
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      assert.equal(r.ok, true, JSON.stringify(r.missing));
    } finally { h.cleanup(); }
  });

  it('does not demand hooks/lib on a machine running the Node hook', () => {
    // No .sh SessionStart hook → the bash hook's lib/ requirement does not apply.
    const h = makeHome({ satisfyWith: { session_start_hook: 1 }, omit: ['hook_lib'] });
    try {
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      assert.equal(r.ok, true, JSON.stringify(r.missing));
      assert.equal(r.checked, ARTIFACTS.length - 1, 'hook_lib should have been skipped');
    } finally { h.cleanup(); }
  });

  it('does demand hooks/lib when the bash hook IS the one installed', () => {
    // The bash hook runs `$SCRIPT_DIR/lib/session-start-output.js`; without lib/ it renders
    // nothing and the session starts with no memories, silently.
    const h = makeHome({ omit: ['hook_lib'] });
    try {
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      assert.equal(r.ok, false);
      assert.ok(r.missing.some((m) => m.id === 'hook_lib'));
    } finally { h.cleanup(); }
  });
});

describe('directories are never accepted as evidence on their own', () => {
  // Both of these directories are created by an unconditional mkdir -p that runs BEFORE the
  // copy that fills them, so an empty one proves only that the script reached that line.
  it('an empty git-hooks directory does not pass', () => {
    const h = makeHome({ omit: ['git_hooks'] });
    try {
      mkdirSync(join(h.ownmindDir, 'git-hooks'), { recursive: true });
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      assert.ok(r.missing.some((m) => m.id === 'git_hooks'));
    } finally { h.cleanup(); }
  });

  it('an empty hooks/lib directory does not pass', () => {
    const h = makeHome({ omit: ['hook_lib'] });
    try {
      mkdirSync(join(h.home, '.claude', 'hooks', 'lib'), { recursive: true });
      const r = checkInstallArtifacts({ home: h.home, ownmindDir: h.ownmindDir });
      assert.ok(r.missing.some((m) => m.id === 'hook_lib'));
    } finally { h.cleanup(); }
  });
});

describe('install-artifacts CLI (this is what install.sh calls)', () => {
  it('exits 0 and says so when complete', () => {
    const h = makeHome();
    try {
      const out = execFileSync(process.execPath,
        [HELPER, '--ownmind-dir', h.ownmindDir, '--home', h.home], { encoding: 'utf8' });
      assert.match(out, /install complete/);
    } finally { h.cleanup(); }
  });

  it('exits non-zero and names what is missing', () => {
    const h = makeHome({ omit: ['session_start_hook'] });
    try {
      let code = 0;
      let stderr = '';
      try {
        execFileSync(process.execPath,
          [HELPER, '--ownmind-dir', h.ownmindDir, '--home', h.home],
          { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        code = err.status;
        stderr = err.stderr;
      }
      assert.equal(code, 1, 'install.sh keys off the exit code');
      assert.match(stderr, /INCOMPLETE/);
      assert.match(stderr, /memories/);
    } finally { h.cleanup(); }
  });

  it('honours --home rather than os.homedir()', () => {
    // Under Git Bash, $HOME and USERPROFILE can differ. If the checker used os.homedir()
    // it would look at the wrong tree and report six phantom missing artifacts.
    const h = makeHome();
    try {
      const out = execFileSync(process.execPath,
        [HELPER, '--ownmind-dir', h.ownmindDir, '--home', h.home],
        { encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent-home-for-this-test' } });
      assert.match(out, /install complete/);
    } finally { h.cleanup(); }
  });
});

describe('the artifact list has exactly one home', () => {
  it('self-check.cjs derives its item from the shared module', () => {
    const src = readFileSync(new URL('../scripts/install-helpers/self-check.cjs', import.meta.url), 'utf8');
    assert.match(src, /require\('\.\/install-artifacts\.cjs'\)/,
      'self-check must call the shared checker, not keep a second list');
  });

  it('install.sh calls the CLI, passes --home, and exits 2 rather than 1', () => {
    const src = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
    assert.match(src, /install-artifacts\.cjs/);
    assert.match(src, /--home "\$HOME"/, 'must not let node infer HOME on Git Bash');
    assert.match(src, /\[FAIL\] Installation did not complete/);
    // 2, not 1: interactive-upgrade.sh rolls back on any other non-zero, and rollback only
    // replaces ~/.ownmind while ~/.claude has already been rewritten.
    assert.match(src, /^\s*exit 2$/m);
  });

  it('interactive-upgrade.sh does not roll back on exit 2', () => {
    const src = readFileSync(new URL('../scripts/interactive-upgrade.sh', import.meta.url), 'utf8');
    const branch = /install_status[\s\S]*?\n\s*fi\n/.exec(src);
    assert.ok(branch, 'the install.sh invocation branch was not found');
    assert.match(branch[0], /-eq 2/, 'exit 2 must be handled separately');
    // Within the exit-2 branch specifically, rollback must not be *called*. Matching the
    // bare word would hit the branch's own explanation of why it does not roll back.
    const two = /elif \[ "\$\{install_status\}" -eq 2 \][\s\S]*?(?=\n  else)/.exec(branch[0]);
    assert.ok(two, 'the exit-2 branch was not found');
    assert.doesNotMatch(two[0], /^\s*rollback\s*$/m,
      'rollback only replaces ~/.ownmind; ~/.claude has already been rewritten by then');
    // And the `else` branch that follows it must still roll back, or this test proves nothing.
    assert.match(branch[0], /\n  else\n\s*rollback\n/);
  });
});
