/**
 * #98 — the installer never asked whether the tools it is built on are reachable.
 *
 * A teammate ran the documented Windows one-liner on a machine with OwnMind installed and no
 * `git` on PATH. bootstrap.ps1 detected the install and delegated to interactive-upgrade.ps1,
 * which copied the whole of ~/.ownmind to ~/.ownmind.bak.<ts> and then died on its first git
 * call with nothing but PowerShell's raw "command not found" text. No `ERROR:` line, no
 * `Report-Error`, and a stray backup left behind protecting an upgrade that never started.
 *
 * `Get-Command git` appeared nowhere in bootstrap.ps1, interactive-upgrade.ps1 or
 * scripts/install-helpers/*.ps1. The `.git` test those scripts do make asks whether a directory
 * is a repository, which is a different question.
 *
 * Every test here runs the real script with a PATH that genuinely does not contain the tool,
 * rather than faking the lookup. The repository's own history is the reason: faking both ends
 * of an interface only proves the fakes agree.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { toBashPath } from './helpers/bash-script.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

/** Where a tool actually lives, or '' when this machine does not have it. */
function locate(tool) {
  try {
    const out = execFileSync(isWindows ? 'where' : 'which', [tool], { encoding: 'utf8', stdio: 'pipe' });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first && fs.existsSync(first) ? first : '';
  } catch { return ''; }
}

/** Windows PowerShell by absolute path — the tests below hand the child an empty PATH. */
const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);

/**
 * A directory holding the listed tools and nothing else, to be used as the whole PATH.
 *
 * Symlinks, not copies. On Windows every one of these is a Git Bash program that loads
 * msys-2.0.dll from the directory it sits in, so a copy into a temp directory dies with
 * "error while loading shared libraries" before the script under test gets a word in — which
 * would have made this suite assert about the wrong failure.
 *
 * Returns null when the tool is absent or the symlink cannot be made (Windows wants a
 * privilege for that), so the caller skips with a stated reason rather than asserting against
 * a PATH it did not manage to build. On Windows the PowerShell tests are the ones that
 * reproduce the reported incident anyway.
 */
function binDirWith(tools) {
  const dir = tempDir('om-preflight-bin-');
  for (const tool of tools) {
    const from = locate(tool);
    if (!from) return null;
    try {
      fs.symlinkSync(from, path.join(dir, path.basename(from)));
    } catch { return null; }
  }
  return dir;
}

/**
 * A curated PATH that bash can actually work under, or null.
 *
 * Measured on Windows: a Git Bash program reached through a symlink outside `Git\usr\bin`
 * still cannot load msys-2.0.dll, so `date` exits non-zero, `set -e` ends the script at its
 * third line, and every test below would have been reading a 127 as though it were the
 * preflight stopping the run. One of them did pass that way before this was added.
 *
 * So the staged PATH is smoke-tested rather than assumed: a script that calls each tool has
 * to succeed before any assertion is made against it. On Linux and macOS it does, and the
 * shell half of this issue is covered there for real. On Windows this returns null and the
 * shell tests state that they did not run — the PowerShell tests are the ones that reproduce
 * the reported incident anyway.
 */
function stagedShell(tools, mustBeMissing = ['git', 'node']) {
  const bash = locate('bash');
  if (!bash) return null;
  const bin = binDirWith(tools);
  if (!bin) return null;

  const probe = path.join(tempDir('om-preflight-smoke-'), 'smoke.sh');
  const lines = ['set -e'];
  for (const tool of tools) lines.push(`${tool} --version >/dev/null 2>&1 || ${tool} >/dev/null 2>&1`);
  // The other half, and the one CI had to teach this file. A staged PATH is a claim that the
  // tool is gone, and on the Windows runner it was not: git stayed reachable through Git Bash's
  // own resolution, so `bootstrap.sh` cheerfully cloned a repository inside a test that was
  // asserting it would refuse to. Silence about that read as a product bug.
  for (const tool of mustBeMissing) lines.push(`command -v ${tool} >/dev/null 2>&1 && { echo "STILL_HAS:${tool}"; exit 0; }`);
  lines.push('echo STAGED_OK', '');
  fs.writeFileSync(probe, lines.join('\n'), 'utf8');

  const r = spawnSync(bash, [toBashPath(probe)], { encoding: 'utf8', env: { PATH: bin } });
  if (r.status !== 0 || !/STAGED_OK/.test(r.stdout || '')) return null;
  return { bash, bin };
}

/** What a skipped shell test says, so it cannot be mistaken for a passing one. */
const NO_SHELL = 'this machine cannot build a PATH that bash runs under and that really lacks the tool (see stagedShell); nothing was run';

describe('#98 bootstrap stops when git is missing, before touching anything', () => {
  it('bootstrap.ps1 names the missing tool, prints the command, and exits 1', {
    skip: isWindows ? false : 'the PowerShell path only exists on Windows',
  }, () => {
    const home = tempDir('om-preflight-home-');
    const r = spawnSync(POWERSHELL, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(repoRoot, 'scripts', 'bootstrap.ps1'),
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        // Empty on purpose. PowerShell's own cmdlets do not come from PATH, so the script
        // still runs — it simply cannot find git, which is the situation being reproduced.
        PATH: '',
        Path: '',
        USERPROFILE: home,
        HOME: home,
        OWNMIND_DIR: path.join(home, '.ownmind'),
      },
    });

    const said = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 1, `expected a clean stop, got ${r.status}:\n${said}`);
    assert.match(said, /preflight_missing_git/, said);
    assert.match(said, /winget install --id Git\.Git/, 'the remedy has to be the command itself');
    // Nothing was created: the whole point is that it stops before doing work.
    assert.equal(fs.existsSync(path.join(home, '.ownmind')), false);
    assert.deepEqual(fs.readdirSync(home).filter((n) => n.includes('.bak')), []);
  });

  it('bootstrap.sh names the missing tool, prints the command, and exits 1', (t) => {
    // date and uname run before the git check; without them the script dies earlier and this
    // test would be asserting about the wrong failure.
    const staged = stagedShell(['date', 'uname']);
    if (!staged) return void t.skip(NO_SHELL);
    const { bash, bin } = staged;

    const home = tempDir('om-preflight-home-sh-');
    const r = spawnSync(bash, [toBashPath(path.join(repoRoot, 'scripts', 'bootstrap.sh'))], {
      encoding: 'utf8',
      env: {
        PATH: bin,
        HOME: toBashPath(home),
        OWNMIND_DIR: toBashPath(path.join(home, '.ownmind')),
      },
    });

    const said = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 1, `expected a clean stop, got ${r.status}:\n${said}`);
    assert.match(said, /preflight_missing_git/, said);
    assert.match(said, /fix:/, 'the remedy has to be on screen');
    assert.equal(fs.existsSync(path.join(home, '.ownmind')), false);
  });
});

describe('#98 the upgrade stops before the backup', () => {
  it('interactive-upgrade.sh leaves no .ownmind.bak.* behind when git is missing', (t) => {
    const staged = stagedShell(['date', 'uname', 'mkdir', 'cat', 'grep', 'cut', 'tr', 'tail']);
    if (!staged) return void t.skip(NO_SHELL);
    const { bash, bin } = staged;

    // A checkout-shaped directory: enough for the script to get past its own two directory
    // tests and reach the preflight. The backup step is the next thing after that.
    const home = tempDir('om-preflight-upgrade-');
    const dir = path.join(home, '.ownmind');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts', 'install-helpers'), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, 'scripts', 'install-helpers', 'preflight.sh'),
      path.join(dir, 'scripts', 'install-helpers', 'preflight.sh'),
    );

    const r = spawnSync(bash, [toBashPath(path.join(repoRoot, 'scripts', 'interactive-upgrade.sh'))], {
      encoding: 'utf8',
      env: { PATH: bin, HOME: toBashPath(home), OWNMIND_DIR: toBashPath(dir) },
    });

    const said = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, `the upgrade reported success with no git:\n${said}`);
    // Named exactly, not a loose /preflight/: the script's own path contains the word, and a
    // run that died somewhere else entirely would have matched that.
    assert.match(said, /ERROR:preflight_missing_git/, said);

    // The assertion this issue exists for. In the incident the backup ran, the upgrade did
    // not, and the copy was pure litter.
    const strays = fs.readdirSync(home).filter((n) => n.startsWith('.ownmind.bak'));
    assert.deepEqual(strays, [], `a backup was made before the environment was checked: ${strays}`);
  });

  it('the preflight call sits above the backup in both upgrade scripts', () => {
    // Cheap and exact. The ordering is the whole fix, and a later edit that moves either call
    // would otherwise only show up as litter on somebody's machine.
    const cases = [
      ['scripts/interactive-upgrade.sh', /ownmind_preflight_assert/, /STEP "backup"/],
      ['scripts/interactive-upgrade.ps1', /Assert-OwnMindRequirements/, /Step "backup"/],
    ];
    for (const [rel, preflight, backup] of cases) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      const atPreflight = src.search(preflight);
      const atBackup = src.search(backup);
      assert.notEqual(atPreflight, -1, `${rel} no longer calls the preflight`);
      assert.notEqual(atBackup, -1, `${rel} backup step was renamed; this guard needs updating`);
      assert.ok(atPreflight < atBackup, `${rel} checks the environment after backing up`);
    }
  });
});

describe('#98 every unmet requirement is reported in one pass', () => {
  it('preflight.ps1 reports git and node together, not one at a time', {
    skip: isWindows ? false : 'the PowerShell path only exists on Windows',
  }, () => {
    const script = [
      `. '${path.join(repoRoot, 'scripts', 'install-helpers', 'preflight.ps1').replace(/'/g, "''")}'`,
      "$env:PATH = ''",
      '$f = Test-OwnMindRequirements',
      '$f | ForEach-Object { Write-Output $_.Name }',
    ].join('\n');
    const file = path.join(tempDir('om-preflight-ps-'), 'probe.ps1');
    fs.writeFileSync(file, script, 'utf8');

    const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      encoding: 'utf8',
    });
    const names = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    assert.ok(names.includes('git'), `git was not reported: ${r.stdout}${r.stderr}`);
    assert.ok(names.includes('node'), `node was not reported: ${r.stdout}${r.stderr}`);
  });

  it('reverse control: on this machine, which has the tools, it reports nothing', {
    skip: isWindows ? false : 'the PowerShell path only exists on Windows',
  }, () => {
    // Without this, a Test-OwnMindRequirements that always returned every tool would pass the
    // test above and stop every install on earth.
    const script = [
      `. '${path.join(repoRoot, 'scripts', 'install-helpers', 'preflight.ps1').replace(/'/g, "''")}'`,
      '$f = Test-OwnMindRequirements',
      'Write-Output "COUNT=$($f.Count)"',
      '$f | ForEach-Object { Write-Output "LEFT=$($_.Name): $($_.Problem)" }',
    ].join('\n');
    const file = path.join(tempDir('om-preflight-ps2-'), 'probe.ps1');
    fs.writeFileSync(file, script, 'utf8');

    const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      encoding: 'utf8',
    });
    assert.match(r.stdout, /COUNT=0/, `this machine runs the suite, so it has the tools: ${r.stdout}${r.stderr}`);
  });

  it('preflight.sh reports node and npm while leaving the git it can see alone', (t) => {
    // Runnable where the one above is not, including Windows: PATH is set to the single
    // directory bash itself lives in, which on a Git Bash install carries git and the
    // coreutils and does not carry node. No symlinks, no copies, so nothing to fail to load.
    //
    // It is the half of the behaviour the other test cannot show — that a tool which IS
    // present is not reported. A preflight that named everything would stop every install.
    const bash = locate('bash');
    const git = locate('git');
    if (!bash || !git) return void t.skip('bash or git is not on this machine; nothing was run');
    // Two real directories off this machine's own PATH — the one bash lives in, which carries
    // the coreutils, plus the one git lives in. Neither carries node on a normal install.
    const dirs = [...new Set([path.dirname(bash), path.dirname(git)])];
    const bin = dirs.join(path.delimiter);
    if (dirs.some((d) => fs.existsSync(path.join(d, `node${isWindows ? '.exe' : ''}`)))) {
      return void t.skip(`node lives alongside bash or git here (${bin}); this test needs it absent`);
    }

    const probe = path.join(tempDir('om-preflight-sh-same-'), 'probe.sh');
    fs.writeFileSync(probe, [
      `. "${toBashPath(path.join(repoRoot, 'scripts', 'install-helpers', 'preflight.sh'))}"`,
      'ownmind_preflight_failures | cut -f1',
      '',
    ].join('\n'), 'utf8');

    const r = spawnSync(bash, [toBashPath(probe)], {
      encoding: 'utf8',
      env: { PATH: bin, HOME: toBashPath(os.tmpdir()) },
    });
    const names = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    assert.equal(r.status, 0, `the probe itself failed:\n${r.stdout}${r.stderr}`);
    assert.ok(names.includes('node'), `node is not on this PATH and was not reported: ${r.stdout}${r.stderr}`);
    assert.ok(!names.includes('git'), `git IS on this PATH and was reported anyway: ${names.join(', ')}`);
  });

  it('preflight.sh reports git and node together', (t) => {
    // cut is for the probe below; uname and grep are what the module itself uses. git and node
    // are deliberately absent, which is what is being measured.
    const staged = stagedShell(['uname', 'grep', 'cut']);
    if (!staged) return void t.skip(NO_SHELL);
    const { bash, bin } = staged;

    const probe = path.join(tempDir('om-preflight-sh-'), 'probe.sh');
    fs.writeFileSync(probe, [
      `. "${toBashPath(path.join(repoRoot, 'scripts', 'install-helpers', 'preflight.sh'))}"`,
      'ownmind_preflight_failures | cut -f1',
      '',
    ].join('\n'), 'utf8');

    const r = spawnSync(bash, [toBashPath(probe)], {
      encoding: 'utf8',
      env: { PATH: bin, HOME: toBashPath(os.tmpdir()) },
    });
    const names = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    assert.ok(names.includes('git'), `git was not reported: ${r.stdout}${r.stderr}`);
    assert.ok(names.includes('node'), `node was not reported: ${r.stdout}${r.stderr}`);
  });
});

describe('#98 the assumptions the Windows check rests on', () => {
  it('Get-Command -CommandType Application really does hand back a path in .Source', {
    skip: isWindows ? false : 'the PowerShell path only exists on Windows',
  }, () => {
    // An independent review of this file claimed .Source is empty for an Application and that
    // every machine would therefore be told it has no git. Measured on PowerShell 5.1, it is
    // the full path — the claim was wrong. It is pinned here rather than argued about, because
    // if it ever became true the preflight would block every install on earth.
    const probe = path.join(tempDir('om-preflight-src-'), 'probe.ps1');
    fs.writeFileSync(probe, [
      'Set-StrictMode -Version Latest',
      "$g = Get-Command git -CommandType Application -ErrorAction SilentlyContinue",
      'if ($g -is [array]) { $g = $g[0] }',
      'if (-not $g) { Write-Output "NO-GIT"; exit 0 }',
      'Write-Output ("SOURCE=" + $g.Source)',
    ].join('\n'), 'utf8');

    const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe], {
      encoding: 'utf8',
    });
    if (/NO-GIT/.test(r.stdout)) return; // nothing to measure on a machine without git
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('SOURCE='));
    assert.ok(line, `the probe said nothing: ${r.stdout}${r.stderr}`);
    const source = line.slice('SOURCE='.length).trim();
    assert.ok(source.length > 0, '.Source came back empty; every tool lookup in preflight.ps1 is now blind');
    assert.ok(fs.existsSync(source), `.Source is not a path that exists: ${source}`);
  });

  it('a program that cannot be launched at all is reported, not thrown', {
    skip: isWindows ? false : 'the PowerShell path only exists on Windows',
  }, () => {
    // `$LASTEXITCODE` does not exist until a native command has run, and under Set-StrictMode
    // reading it then throws instead of returning $null. The npm check reads it right after
    // invoking npm, so a shim that fails to launch would have taken the whole preflight down
    // — reported as "npm does not run", which is at least the right shape, but by accident.
    const probe = path.join(tempDir('om-preflight-exit-'), 'probe.ps1');
    const helper = path.join(repoRoot, 'scripts', 'install-helpers', 'preflight.ps1').replace(/'/g, "''");
    fs.writeFileSync(probe, [
      `. '${helper}'`,
      // Nothing native has run in this session yet, which is the state being reproduced.
      'Write-Output ("EXIT=" + (Get-OwnMindLastExit))',
      'Write-Output ("MAJOR=" + (Get-OwnMindNodeMajor ""))',
    ].join('\n'), 'utf8');

    const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe], {
      encoding: 'utf8',
    });
    assert.match(r.stdout, /EXIT=-1/, `reading an unset $LASTEXITCODE was not survived: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /MAJOR=-1/, `an empty program path was not handled: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr || '', /cannot be retrieved because it has not been set/, r.stderr);
  });
});

describe('#98 one missing tool has one name', () => {
  it('all four scripts print ERROR:preflight_missing_<tool>', () => {
    // It did not, and CI is what noticed: the two preflight modules printed
    // `preflight_missing_<tool>` as the reported kind and `preflight_<tool>` on screen, while
    // both bootstraps printed the longer form. Somebody grepping their terminal for what the
    // console told them would have found nothing.
    const cases = [
      ['scripts/install-helpers/preflight.sh', /ERROR:preflight_missing_%s:/],
      ['scripts/install-helpers/preflight.ps1', /ERROR:preflight_missing_\$\(\$f\.Name\):/],
      ['scripts/bootstrap.sh', /log_err preflight_missing_git/],
      ['scripts/bootstrap.ps1', /Log-Err preflight_missing_git/],
    ];
    for (const [rel, pattern] of cases) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assert.match(src, pattern, `${rel} no longer prints the shared preflight_missing_ prefix`);
    }
  });

  it('and the reported kind is that same word', () => {
    // The kind is what the console groups by. A screen that says one thing and a report that
    // says another is two records of one event.
    for (const rel of ['scripts/install-helpers/preflight.sh', 'scripts/install-helpers/preflight.ps1']) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assert.match(src, /preflight_missing_\$\{?name\}?|preflight_missing_\$\(\$f\.Name\)/,
        `${rel} reports a kind that is not preflight_missing_<tool>`);
    }
  });
});

describe('#98 the two sides state the same floor', () => {
  it('the Node floor is the same number in both preflights and in install.ps1', () => {
    // Three copies of one decision. They have drifted apart in this repository before, and a
    // floor that differs by platform is a machine that installs on one OS and not the other.
    const read = (rel, re) => {
      const m = re.exec(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
      assert.ok(m, `${rel} no longer states a Node floor this guard can read`);
      return Number(m[1]);
    };
    const ps = read('scripts/install-helpers/preflight.ps1', /OwnMindNodeFloor\s*=\s*(\d+)/);
    const sh = read('scripts/install-helpers/preflight.sh', /OWNMIND_NODE_FLOOR\s*=\s*(\d+)/);
    const installer = read('install.ps1', /\$nodeMajor\s+-lt\s+(\d+)/);
    assert.equal(ps, sh, 'the Windows and shell preflights disagree about the Node floor');
    assert.equal(ps, installer, 'the preflight and install.ps1 disagree about the Node floor');
  });
});
