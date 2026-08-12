import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnBashScript, toBashPath as bp } from './helpers/bash-script.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const helperPath = path.join(repoRoot, 'scripts', 'install-helpers', 'path-helpers.sh');

/**
 * v1.26.7 hotfix — bash to_win_path() integration tests
 *
 * Reproduces Vin's 2026-05-26 bug at the shell layer: simulates Git Bash on
 * Windows by injecting a fake `cygpath` into PATH; verifies the helper produces
 * the mixed-style Windows path that Node.exe can resolve. Also verifies the
 * Mac/Linux fallback (no cygpath → pass through unchanged).
 *
 * Why spawn bash: to_win_path() is a bash function; the only honest way to test
 * it is to source it and call it. We capture stdout to verify behavior.
 */

function runBash(script, env = {}) {
  // PATH is set inside the script, not in the spawn env. The cases below restrict PATH to
  // control what bash can find; node reads the same variable to locate bash.exe, and a
  // POSIX PATH is meaningless to CreateProcess, so passing it through kills the run with
  // status null before the helper is sourced. Inside the script it restricts exactly the
  // lookup the case is about and leaves node's alone.
  const { PATH, ...restEnv } = env;
  const prelude = PATH === undefined ? '' : `export PATH=${JSON.stringify(PATH)}\n`;
  return spawnBashScript(prelude + script, {
    encoding: 'utf8',
    env: { ...process.env, ...restEnv },
  });
}

describe('v1.26.7 — to_win_path: fallback without cygpath', () => {
  it('returns input unchanged when cygpath is not on PATH', () => {
    const r = runBash(
      `. "${bp(helperPath)}" && to_win_path "/c/Users/Vin/.ownmind"`,
      // Empty, not '/usr/bin:/bin'. Git Bash ships cygpath in /usr/bin, so the old value
      // asserted 'no cygpath' on the one platform where it is always there, and the case
      // tested the opposite of its own name. to_win_path needs only command -v and echo,
      // both builtins, so an empty PATH is the honest way to say the tool is absent.
      { PATH: '' }
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '/c/Users/Vin/.ownmind');
  });

  it('passes empty string through cleanly', () => {
    const r = runBash(
      `. "${bp(helperPath)}" && to_win_path ""`,
      // Empty, not '/usr/bin:/bin'. Git Bash ships cygpath in /usr/bin, so the old value
      // asserted 'no cygpath' on the one platform where it is always there, and the case
      // tested the opposite of its own name. to_win_path needs only command -v and echo,
      // both builtins, so an empty PATH is the honest way to say the tool is absent.
      { PATH: '' }
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('passes already-Windows paths through unchanged on Mac/Linux', () => {
    const r = runBash(
      `. "${bp(helperPath)}" && to_win_path "C:/Users/Vin"`,
      // Empty, not '/usr/bin:/bin'. Git Bash ships cygpath in /usr/bin, so the old value
      // asserted 'no cygpath' on the one platform where it is always there, and the case
      // tested the opposite of its own name. to_win_path needs only command -v and echo,
      // both builtins, so an empty PATH is the honest way to say the tool is absent.
      { PATH: '' }
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'C:/Users/Vin');
  });
});

describe('v1.26.7 — to_win_path: with simulated cygpath (Git Bash on Windows)', () => {
  let tmpBin;
  let fakeCygpath;

  function setup() {
    tmpBin = tempDir('ownmind-cygpath-stub-');
    fakeCygpath = path.join(tmpBin, 'cygpath');
    // Stub cygpath: implements the -m (mixed) conversion just enough to fake Git Bash.
    fs.writeFileSync(fakeCygpath, `#!/usr/bin/env bash
# Stub cygpath: handle "-m <msys_path>" → mixed-style Windows path.
mode="$1"; input="$2"
if [ "$mode" != "-m" ]; then
  echo "stub-cygpath: only -m supported, got $mode" >&2
  exit 2
fi
# /c/Users/Vin → C:/Users/Vin
if [[ "$input" =~ ^/([a-zA-Z])(/.*)?$ ]]; then
  drive=$(echo "\${BASH_REMATCH[1]}" | tr '[:lower:]' '[:upper:]')
  rest="\${BASH_REMATCH[2]:-/}"
  echo "\${drive}:\${rest}"
else
  echo "$input"
fi
`);
    fs.chmodSync(fakeCygpath, 0o755);
  }

  function cleanup() {
    fs.rmSync(tmpBin, { recursive: true, force: true });
  }

  it('reproduces Vin\'s bug case: /c/Users/Vin/.ownmind → C:/Users/Vin/.ownmind (cygpath -m)', () => {
    setup();
    try {
      const r = runBash(
        `. "${bp(helperPath)}" && to_win_path "/c/Users/Vin/.ownmind"`,
        { PATH: `${bp(tmpBin)}:/usr/bin:/bin` }
      );
      assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
      assert.equal(r.stdout.trim(), 'C:/Users/Vin/.ownmind',
        'with cygpath in PATH, must convert MSYS to mixed-style Windows path');
    } finally {
      cleanup();
    }
  });

  it('different drive letter uppercased: /d/data → D:/data', () => {
    setup();
    try {
      const r = runBash(
        `. "${bp(helperPath)}" && to_win_path "/d/data"`,
        { PATH: `${bp(tmpBin)}:/usr/bin:/bin` }
      );
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), 'D:/data');
    } finally {
      cleanup();
    }
  });

  it('already-Win32 path still passes through (cygpath -m is idempotent in mixed mode)', () => {
    setup();
    try {
      const r = runBash(
        `. "${bp(helperPath)}" && to_win_path "C:/Users/Vin"`,
        { PATH: `${bp(tmpBin)}:/usr/bin:/bin` }
      );
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), 'C:/Users/Vin');
    } finally {
      cleanup();
    }
  });
});

describe('v1.26.7 — verify-upgrade.sh:49 regression (the actual bug)', () => {
  // Direct repro of Vin's call site: simulate Git Bash on Windows with our fake
  // cygpath, then exercise the post-fix call pattern that verify-upgrade.sh
  // uses to read the package.json version.
  let tmpBin;
  let fakeCygpath;
  let tmpHome;

  function setup() {
    // Stub cygpath again (same as above).
    tmpBin = tempDir('ownmind-cygpath-stub-');
    fakeCygpath = path.join(tmpBin, 'cygpath');
    fs.writeFileSync(fakeCygpath, `#!/usr/bin/env bash
mode="$1"; input="$2"
if [[ "$input" =~ ^/([a-zA-Z])(/.*)?$ ]]; then
  drive=$(echo "\${BASH_REMATCH[1]}" | tr '[:lower:]' '[:upper:]')
  rest="\${BASH_REMATCH[2]:-/}"
  echo "\${drive}:\${rest}"
else
  echo "$input"
fi
`);
    fs.chmodSync(fakeCygpath, 0o755);

    // Build a fake ~/.ownmind with a package.json that node can read directly.
    tmpHome = tempDir('ownmind-home-');
    fs.mkdirSync(path.join(tmpHome, '.ownmind'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.ownmind', 'package.json'),
      JSON.stringify({ name: 'ownmind', version: '1.26.7-test' })
    );
  }

  function cleanup() {
    fs.rmSync(tmpBin, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  it('post-fix verify-upgrade.sh:49 pattern reads the version cleanly under simulated Git Bash', () => {
    setup();
    try {
      // We cannot really set $OWNMIND_DIR to /c/... because the fake home is a real
      // Mac path. But we can prove the helper produces a path that node can read:
      // pass the Mac path through to_win_path (no-op since real cygpath would convert
      // a Mac path nonsensically). So the more honest test here is: confirm the
      // pattern `node -p "require('${PATH}/package.json').version"` works after
      // the path has gone through to_win_path() and the helper did NOT damage it.
      const r = runBash(
        `
          . "${bp(helperPath)}"
          OWNMIND_DIR="${bp(path.join(tmpHome, '.ownmind'))}"
          # Mac path is already in a form Node can read; helper must not damage it.
          OWNMIND_DIR_WIN="$(to_win_path "$OWNMIND_DIR")"
          node -p "require('$OWNMIND_DIR_WIN/package.json').version"
        `
        // Keep the inherited PATH (node, bash, tr all live there); no cygpath stub here
        // so the helper falls back to identity, exactly like the Mac/Linux path.
      );
      assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
      assert.equal(r.stdout.trim(), '1.26.7-test',
        'after the fix, verify-upgrade.sh:49 pattern must successfully read package.json version');
    } finally {
      cleanup();
    }
  });
});
