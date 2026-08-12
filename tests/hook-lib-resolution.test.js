// v1.26.129 — the session hook must run its lib modules where their imports resolve.
//
// `update.sh` copies `hooks/lib/*.js` into `~/.claude/hooks/lib/` and has never copied
// `shared/`. A module that imports `../../shared/…` therefore resolves to `~/.claude/shared/`,
// which does not exist, and dies at load with ERR_MODULE_NOT_FOUND.
//
// This was not theoretical. `conditional-sync.js` imports `shared/scanners/base.js`, the hook
// invoked it as `$SCRIPT_DIR/lib/conditional-sync-cli.js` — i.e. the copy — and every call
// site sends stderr to /dev/null. So the conditional sync failed to load on every session and
// the only trace was an empty `INIT_DATA`, which the hook treats as "the API was slow".
//
// Then v1.26.127 added an import of `shared/tips.js` to `render-session-context.js` and put
// the session context itself into the same class: the memory load would have died the same
// silent way.
//
// The fix is `LIB_DIR`, which prefers the checkout (where `shared/` is a sibling). This file
// keeps it that way.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hookPath = join(repoRoot, 'hooks', 'ownmind-session-start.sh');
const hook = readFileSync(hookPath, 'utf8');

describe('the session hook resolves lib modules against the checkout', () => {
  it('defines LIB_DIR preferring $OWNMIND_DIR, with a fallback', () => {
    assert.match(hook, /LIB_DIR="\$OWNMIND_DIR\/hooks\/lib"/);
    // The fallback is guarded on shared/ as well as lib/, because shared/ is the whole reason
    // the checkout is preferred — checking only lib/ would assert something else.
    assert.match(hook, /\[ -d "\$OWNMIND_DIR\/shared" \]/);
    assert.match(hook, /LIB_DIR="\$SCRIPT_DIR_FOR_FLUSH\/lib"/);
  });

  it('invokes every lib module through LIB_DIR', () => {
    // The specific regression: one call site left on $SCRIPT_DIR is enough, because each of
    // them is a different feature failing silently on its own.
    const viaScriptDir = [...hook.matchAll(/\$\{?SCRIPT_DIR[A-Z_]*\}?\/lib\/[\w.-]+/g)].map((m) => m[0]);
    assert.deepEqual(
      viaScriptDir, [],
      'a lib module is still invoked relative to this script rather than through LIB_DIR: '
      + `${viaScriptDir.join(', ')} — it will not find shared/ when run from ~/.claude/hooks`,
    );
  });

  it('every lib module the hook runs is actually there', () => {
    const called = [...hook.matchAll(/\$LIB_DIR\/([\w.-]+\.js)/g)].map((m) => m[1]);
    assert.ok(called.length > 3, `only ${called.length} lib invocations found — the regex broke`);
    const present = new Set(readdirSync(join(repoRoot, 'hooks', 'lib')));
    for (const f of called) {
      assert.ok(present.has(f), `the hook runs hooks/lib/${f}, which does not exist`);
    }
  });
});

describe('the failure mode this guards is real', () => {
  it('a lib module importing shared/ dies when run without a sibling shared/', () => {
    // Reproduces `~/.claude/hooks/lib` exactly: the modules, none of their siblings. If this
    // ever stops failing, the fallback branch of LIB_DIR became safe and this whole file can
    // be reconsidered — but until then, the fallback is a degraded mode, not an equal one.
    const sandbox = tempDir('om-libres-');
    try {
      const libDir = join(sandbox, 'hooks', 'lib');
      mkdirSync(libDir, { recursive: true });
      for (const f of ['session-start-output.js', 'render-session-context.js']) {
        copyFileSync(join(repoRoot, 'hooks', 'lib', f), join(libDir, f));
      }
      let failed = false;
      try {
        execFileSync(process.execPath, [join(libDir, 'session-start-output.js'), '{}', '[]'],
          { stdio: 'pipe' });
      } catch (err) {
        failed = /ERR_MODULE_NOT_FOUND|Cannot find module/.test(String(err.stderr || err));
      }
      assert.ok(failed, 'expected the copy-without-shared layout to fail at module resolution');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('the same module runs from the checkout, where shared/ is a sibling', () => {
    const out = execFileSync(
      process.execPath,
      [join(repoRoot, 'hooks', 'lib', 'session-start-output.js'), '{"server_version":"1.0.0"}', '[]'],
      { encoding: 'utf8' },
    );
    assert.match(out, /additionalContext/);
  });
});
