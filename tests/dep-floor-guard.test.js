import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, copyFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  parseVersion,
  satisfiesFloor,
  readInstalledVersion,
} from '../scripts/install-helpers/dep-floor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const helpersDir = join(repoRoot, 'scripts', 'install-helpers');
const libPath = join(helpersDir, 'dep-floor.mjs');
const cliPath = join(helpersDir, 'dep-floor-cli.mjs');
const updateShPath = join(repoRoot, 'scripts', 'update.sh');
const updatePs1Path = join(repoRoot, 'scripts', 'update.ps1');

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

/** Minimum version a caret / tilde / bare range accepts, e.g. "^4.3.0" -> "4.3.0". */
function rangeFloor(range) {
  const match = /(\d+\.\d+\.\d+)/.exec(String(range));
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// parseVersion
// ---------------------------------------------------------------------------

test('parseVersion reads a plain semver triple', () => {
  assert.deepEqual(parseVersion('4.3.0'), { core: [4, 3, 0], pre: false });
  assert.deepEqual(parseVersion('10.0.12'), { core: [10, 0, 12], pre: false });
});

test('parseVersion tolerates a leading v and surrounding whitespace', () => {
  assert.deepEqual(parseVersion(' v1.1.12 '), { core: [1, 1, 12], pre: false });
});

test('parseVersion marks prereleases but not build metadata', () => {
  assert.equal(parseVersion('4.3.0-rc.1').pre, true);
  assert.equal(parseVersion('4.3.0+build.7').pre, false);
});

test('parseVersion returns null for anything it cannot read', () => {
  for (const bad of ['', '4.3', 'latest', 'abc', '4.x.0', null, undefined, 430, {}]) {
    assert.equal(parseVersion(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// satisfiesFloor
// ---------------------------------------------------------------------------

test('satisfiesFloor rejects the version this bug shipped', () => {
  // The whole point: 4.1.1 sat on machines because the old guard never looked.
  assert.equal(satisfiesFloor('4.1.1', '4.3.0'), false);
  assert.equal(satisfiesFloor('4.2.0', '4.3.0'), false);
});

test('satisfiesFloor accepts the floor itself and anything above it', () => {
  assert.equal(satisfiesFloor('4.3.0', '4.3.0'), true);
  assert.equal(satisfiesFloor('4.3.1', '4.3.0'), true);
  assert.equal(satisfiesFloor('4.4.0', '4.3.0'), true);
  assert.equal(satisfiesFloor('5.0.0', '4.3.0'), true);
});

test('satisfiesFloor compares numerically, not as text', () => {
  // A string compare would put "4.10.0" below "4.9.0".
  assert.equal(satisfiesFloor('4.10.0', '4.9.0'), true);
  assert.equal(satisfiesFloor('4.9.0', '4.10.0'), false);
  assert.equal(satisfiesFloor('1.1.12', '1.1.9'), true);
});

test('satisfiesFloor treats a prerelease of the floor as below it', () => {
  assert.equal(satisfiesFloor('4.3.0-rc.1', '4.3.0'), false);
  assert.equal(satisfiesFloor('4.3.1-rc.1', '4.3.0'), true);
});

test('satisfiesFloor fails safe on unreadable input', () => {
  // Returning false means "reinstall", which is idempotent. Returning true
  // would silently leave a vulnerable copy in place.
  assert.equal(satisfiesFloor(null, '4.3.0'), false);
  assert.equal(satisfiesFloor('garbage', '4.3.0'), false);
  assert.equal(satisfiesFloor('4.3.0', 'garbage'), false);
  assert.equal(satisfiesFloor(undefined, undefined), false);
});

// ---------------------------------------------------------------------------
// readInstalledVersion
// ---------------------------------------------------------------------------

function withFakeInstall(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ownmind-dep-floor-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function installFake(dir, pkg, version) {
  const target = join(dir, 'node_modules', ...pkg.split('/'));
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'package.json'),
    version === undefined ? '{}' : JSON.stringify({ name: pkg, version }),
  );
  return target;
}

test('readInstalledVersion reads the installed manifest', () => {
  withFakeInstall((dir) => {
    installFake(dir, 'js-yaml', '4.1.1');
    assert.equal(readInstalledVersion(dir, 'js-yaml'), '4.1.1');
  });
});

test('readInstalledVersion handles scoped package names', () => {
  withFakeInstall((dir) => {
    installFake(dir, '@hono/node-server', '2.0.12');
    assert.equal(readInstalledVersion(dir, '@hono/node-server'), '2.0.12');
  });
});

test('readInstalledVersion returns null when the package is absent', () => {
  withFakeInstall((dir) => {
    assert.equal(readInstalledVersion(dir, 'js-yaml'), null);
  });
});

test('readInstalledVersion returns null for a manifest with no version', () => {
  withFakeInstall((dir) => {
    installFake(dir, 'js-yaml', undefined);
    assert.equal(readInstalledVersion(dir, 'js-yaml'), null);
  });
});

test('readInstalledVersion returns null for unreadable JSON', () => {
  withFakeInstall((dir) => {
    const target = join(dir, 'node_modules', 'js-yaml');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'package.json'), '{ not json');
    assert.equal(readInstalledVersion(dir, 'js-yaml'), null);
  });
});

// ---------------------------------------------------------------------------
// CLI contract — this is the shape update.sh / update.ps1 depend on
// ---------------------------------------------------------------------------

function runCli(...args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

test('CLI exits 0 when the installed version clears the floor', () => {
  withFakeInstall((dir) => {
    installFake(dir, 'js-yaml', '4.3.0');
    assert.equal(runCli(dir, 'js-yaml', '4.3.0').status, 0);
  });
});

test('CLI exits 1 when the installed version is below the floor', () => {
  withFakeInstall((dir) => {
    installFake(dir, 'js-yaml', '4.1.1');
    assert.equal(runCli(dir, 'js-yaml', '4.3.0').status, 1);
  });
});

test('CLI exits 1 when the package is not installed at all', () => {
  withFakeInstall((dir) => {
    assert.equal(runCli(dir, 'js-yaml', '4.3.0').status, 1);
  });
});

test('CLI exits 1 on missing arguments rather than reporting success', () => {
  assert.equal(runCli().status, 1);
  assert.equal(runCli('/nonexistent').status, 1);
  assert.equal(runCli('/nonexistent', 'js-yaml').status, 1);
});

test('CLI prints nothing on stdout so callers can use it as a plain predicate', () => {
  withFakeInstall((dir) => {
    installFake(dir, 'js-yaml', '4.3.0');
    assert.equal(runCli(dir, 'js-yaml', '4.3.0').stdout, '');
  });
});

test('CLI still answers correctly when reached through a symlinked path', () => {
  // Regression guard. An earlier version decided whether to run its own body by
  // comparing process.argv[1] against import.meta.url. path.resolve is lexical
  // while node realpaths the main module, so any symlinked component made those
  // differ, the body was skipped, and the process exited 0 — read by the shell as
  // "floor met", meaning the dependency was never installed or upgraded again.
  withFakeInstall((dir) => {
    const real = join(dir, 'real');
    mkdirSync(join(real, 'scripts', 'install-helpers'), { recursive: true });
    copyFileSync(libPath, join(real, 'scripts', 'install-helpers', 'dep-floor.mjs'));
    copyFileSync(cliPath, join(real, 'scripts', 'install-helpers', 'dep-floor-cli.mjs'));
    installFake(real, 'js-yaml', '4.3.0');

    const link = join(dir, 'link');
    symlinkSync(real, link);
    const viaLink = join(link, 'scripts', 'install-helpers', 'dep-floor-cli.mjs');

    // An impossible floor: the only correct answer is 1, whichever path is used.
    assert.equal(
      spawnSync(process.execPath, [viaLink, link, 'js-yaml', '9.9.9']).status,
      1,
      'symlinked invocation must still report the floor as unmet',
    );
    assert.equal(
      spawnSync(process.execPath, [viaLink, link, 'js-yaml', '4.3.0']).status,
      0,
      'symlinked invocation must still report a satisfied floor',
    );
  });
});

// ---------------------------------------------------------------------------
// Drift guards — the reason this file exists at all
// ---------------------------------------------------------------------------

const ROOT_DEPS_INSTALLED_BY_UPDATE_SCRIPT = ['js-yaml', 'node-machine-id'];

const UPDATE_SCRIPTS = {
  'update.sh': updateShPath,
  'update.ps1': updatePs1Path,
};

/**
 * Pull the gate floor and the install range for a package out of a script.
 *
 * Anchored on the exact call syntax rather than on "a line mentioning the
 * package and a version": the loose form would happily read a version out of an
 * unrelated executable line — an `echo "upgrading js-yaml from 4.1.1"`, say — and
 * then compare the wrong number while still reporting green.
 *
 * Comments are stripped for the same reason, and it is not theoretical: both
 * scripts carry a comment quoting the original `npm install js-yaml@^4.1.1`
 * command to explain why the old guard failed.
 */
function floorsFor(name, src, pkg) {
  const executable = src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  // Semver-shaped, so a trailing `;` from `needs_root_dep js-yaml 4.3.0; then` is
  // not swallowed into the captured version.
  const SEMVER = '(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.]+)?)';
  const gatePattern = name.endsWith('.ps1')
    ? new RegExp(`Test-RootDepNeeded\\s+-Package\\s+"${pkg}"\\s+-MinVersion\\s+"${SEMVER}"`)
    : new RegExp(`needs_root_dep\\s+${pkg}\\s+${SEMVER}`);
  const installPattern = new RegExp(`npm install ${pkg}@\\^?${SEMVER}`);

  const gate = gatePattern.exec(executable);
  const install = installPattern.exec(executable);
  return { gate: gate?.[1] ?? null, install: install?.[1] ?? null };
}

test('both update scripts gate root deps through the dep-floor CLI', () => {
  for (const [name, path] of Object.entries(UPDATE_SCRIPTS)) {
    const src = readFileSync(path, 'utf8');
    assert.match(
      src,
      /install-helpers[\\/]dep-floor-cli\.mjs/,
      `${name} must call dep-floor-cli.mjs to decide whether a root dep needs installing`,
    );
    assert.doesNotMatch(
      src,
      /install-helpers[\\/]dep-floor\.mjs/,
      `${name} must call the CLI, not import the library module directly`,
    );
  }
});

test('neither update script has its guard polarity inverted', () => {
  // The one mutation that leaves every other assertion green while inverting the
  // behaviour: install exactly when it is not needed, skip when it is. Exit 0
  // means "floor met", so the shell must negate and PowerShell must compare -ne.
  const sh = readFileSync(updateShPath, 'utf8');
  assert.match(
    sh,
    /^\s*!\s*node\s+"\$OWNMIND_DIR\/scripts\/install-helpers\/dep-floor-cli\.mjs"/m,
    'update.sh must negate the exit status: exit 0 means the floor is already met',
  );

  const ps1 = readFileSync(updatePs1Path, 'utf8');
  assert.match(
    ps1,
    /return\s*\(\s*\$LASTEXITCODE\s+-ne\s+0\s*\)/,
    'update.ps1 must return $LASTEXITCODE -ne 0: a non-zero exit means install',
  );
});

test('the shell guard, run as shipped, installs when old and skips when current', { skip: !hasBash }, () => {
  // Source assertions cannot prove the shell wiring works. Extract the real
  // function body out of update.sh and run it against a fake install tree.
  const src = readFileSync(updateShPath, 'utf8');
  const fn = /^needs_root_dep\(\) \{[\s\S]*?^\}/m.exec(src);
  assert.ok(fn, 'update.sh must define needs_root_dep as a shell function');

  // The guard redirects stderr into ~/.ownmind/logs/, so the script must create
  // that directory first. Without it the redirect fails, the whole command fails,
  // the negation flips, and every sync reports "needs install" forever. Taking the
  // line from the script rather than hardcoding it means deleting it turns red.
  const mkdirLogs = /^mkdir -p "\$\{HOME\}\/\.ownmind\/logs".*$/m.exec(src);
  assert.ok(
    mkdirLogs,
    'update.sh must create ~/.ownmind/logs before the guard redirects stderr into it',
  );

  withFakeInstall((home) => {
    const ownmind = join(home, '.ownmind');
    mkdirSync(join(ownmind, 'scripts', 'install-helpers'), { recursive: true });
    copyFileSync(libPath, join(ownmind, 'scripts', 'install-helpers', 'dep-floor.mjs'));
    copyFileSync(cliPath, join(ownmind, 'scripts', 'install-helpers', 'dep-floor-cli.mjs'));

    // HOME is redirected at the fake tree so the guard's stderr redirect cannot
    // append to the real ~/.ownmind/logs/update-err.log.
    const decide = () => {
      const run = spawnSync('bash', ['-c', [
        'OWNMIND_DIR="$1"',
        mkdirLogs[0],
        fn[0],
        'if needs_root_dep js-yaml 4.3.0; then echo INSTALL; else echo SKIP; fi',
      ].join('\n'), 'bash', ownmind], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
      });
      assert.equal(run.stderr, '', `the guard must not emit shell errors: ${run.stderr}`);
      return run.stdout.trim();
    };

    installFake(ownmind, 'js-yaml', '4.1.1');
    assert.equal(decide(), 'INSTALL', 'a vulnerable 4.1.1 must be upgraded');

    installFake(ownmind, 'js-yaml', '4.3.0');
    assert.equal(decide(), 'SKIP', 'a current install must be left alone');

    installFake(ownmind, 'js-yaml', '4.3.1');
    assert.equal(decide(), 'SKIP', 'a newer install must be left alone');

    rmSync(join(ownmind, 'node_modules', 'js-yaml'), { recursive: true, force: true });
    assert.equal(decide(), 'INSTALL', 'an absent package must be installed');

    installFake(ownmind, 'js-yaml', '4.3.0');
    rmSync(join(ownmind, 'scripts', 'install-helpers', 'dep-floor-cli.mjs'));
    assert.equal(decide(), 'INSTALL', 'a missing helper must fail safe, not skip');
  });
});

test('no update script still gates a root dep on directory existence', () => {
  // The original bug: `[ ! -d node_modules/js-yaml ]` / `Test-Path ...\js-yaml`
  // meant a package present at any version was never revisited.
  for (const [name, path] of Object.entries(UPDATE_SCRIPTS)) {
    const src = readFileSync(path, 'utf8');
    for (const pkg of ROOT_DEPS_INSTALLED_BY_UPDATE_SCRIPT) {
      assert.doesNotMatch(
        src,
        new RegExp(`node_modules[\\\\/]${pkg}`),
        `${name} must not reference node_modules/${pkg} directly; version-gate it instead`,
      );
    }
  }
});

test('the floor each update script checks is at least the floor package.json declares', () => {
  const declared = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).dependencies;

  for (const pkg of ROOT_DEPS_INSTALLED_BY_UPDATE_SCRIPT) {
    const declaredFloor = rangeFloor(declared[pkg]);
    assert.ok(declaredFloor, `package.json must declare ${pkg}`);

    for (const [name, path] of Object.entries(UPDATE_SCRIPTS)) {
      const { gate } = floorsFor(name, readFileSync(path, 'utf8'), pkg);
      assert.ok(gate, `${name} must gate ${pkg} against an explicit version`);
      assert.ok(
        satisfiesFloor(gate, declaredFloor),
        `${name} checks ${pkg} against ${gate} but package.json requires >= ${declaredFloor}`,
      );
    }
  }
});

test('the version each update script installs is at least the floor it checks', () => {
  for (const pkg of ROOT_DEPS_INSTALLED_BY_UPDATE_SCRIPT) {
    for (const [name, path] of Object.entries(UPDATE_SCRIPTS)) {
      const { gate, install } = floorsFor(name, readFileSync(path, 'utf8'), pkg);
      assert.ok(install, `${name} must install ${pkg} with an explicit range`);
      assert.ok(
        satisfiesFloor(install, gate),
        `${name} installs ${pkg}@${install} but gates on ${gate}; the install would rerun every sync`,
      );
    }
  }
});

test('js-yaml floor covers the advisory that motivated this guard', () => {
  // CVE-2026-59869 / GHSA-52cp-r559-cp3m: quadratic CPU via YAML merge-key chains.
  // Reachable because iron-rule frontmatter is parsed client-side and shared team
  // standards originate from other accounts.
  const declared = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).dependencies;
  assert.ok(
    satisfiesFloor(rangeFloor(declared['js-yaml']), '4.3.0'),
    'package.json must require js-yaml >= 4.3.0',
  );

  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
  assert.ok(
    satisfiesFloor(lock.packages['node_modules/js-yaml'].version, '4.3.0'),
    'package-lock.json must resolve js-yaml >= 4.3.0',
  );
});
