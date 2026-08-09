import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * Git Bash detection across Git for Windows builds (v1.26.99)
 *
 * Test-IsGitBash identified Git Bash by looking for `msys` in `bash --version`.
 * Git for Windows 2.55 changed the build triplet:
 *
 *   2.54 and earlier: GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)
 *   2.55 and later:   GNU bash, version 5.3.15(1)-release (x86_64-pc-cygwin)
 *
 * So on every machine that updated to 2.55, a working Git Bash was rejected and
 * Find-GitBash returned $null. The caller skips verify_local / verify_server and
 * carries on, so the only trace was one line telling the user to install Git Bash
 * from git-scm.com — while Git Bash was installed. Measured on TANK, 2026-08-08.
 *
 * Two layers, because neither one is enough on its own. The text assertions run
 * everywhere and are what a macOS or Linux checkout gets; they are pinned to the
 * whole branch, value included, since `-match 'msys|cygwin'` followed by
 * `return $false` satisfies a pattern-only assertion while reinstating the exact
 * bug. The behavioural block below dot-sources the shipped helper and runs
 * Test-IsGitBash against stub executables that print each triplet, which is the
 * only layer that can tell recognising a build from accepting it. It needs a
 * PowerShell on the host, so it skips where there is none.
 */

const HELPER = 'scripts/windows/lib/find-git-bash.ps1';
const UPGRADE = 'scripts/interactive-upgrade.ps1';

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

/** pwsh 7 anywhere, Windows PowerShell 5.1 as the fallback the upgrade script itself runs under. */
const powershell = ['pwsh', 'powershell'].find((exe) => {
  try {
    return spawnSync(exe, ['-NoProfile', '-Command', 'exit 0']).status === 0;
  } catch {
    return false;
  }
});

describe('find-git-bash.ps1 — build triplet matching', () => {
  it('accepts cygwin as well as msys', () => {
    const content = read(HELPER);
    assert.match(
      content,
      /\$out\s+-match\s+'msys\|cygwin'/,
      'Test-IsGitBash must accept both msys (<=2.54) and cygwin (>=2.55) triplets',
    );
  });

  it('does not accept msys alone', () => {
    const content = read(HELPER);
    assert.doesNotMatch(
      content,
      /if\s*\(\$out\s+-match\s+'msys'\)/,
      'matching msys alone is the 2.55 regression; it must not come back',
    );
  });

  it('the branch that recognises a Git Bash build is the branch that accepts it', () => {
    // Pinned to the value, not just the pattern. `-match 'msys|cygwin'` with a `return $false`
    // body reads as fixed and behaves exactly like the bug, and every pattern-only assertion
    // in this file stays green through it.
    assert.match(
      read(HELPER),
      /if\s*\(\$out\s+-match\s+'msys\|cygwin'\)\s*\{\s*return\s+\$true\s*\}/,
      'recognising the build must return $true',
    );
  });

  it('still rejects a WSL distro', () => {
    const content = read(HELPER);
    assert.match(
      content,
      /\$out\s+-match\s+'linux-gnu'/,
      'linux-gnu is a WSL distro and must be turned down explicitly',
    );
  });

  it('still rejects the System32 WSL relay', () => {
    const content = read(HELPER);
    assert.match(
      content,
      /System32\\bash\.exe/i,
      'the System32 relay exclusion must survive',
    );
  });
});

describe('find-git-bash.ps1 — reporting why a candidate was turned down', () => {
  it('records rejected candidates', () => {
    const content = read(HELPER);
    assert.match(content, /\$script:GitBashRejected/, 'must collect rejected candidates');
  });

  it('exposes Get-GitBashSearchReport for callers', () => {
    const content = read(HELPER);
    assert.match(
      content,
      /function\s+Get-GitBashSearchReport/i,
      'callers need a way to say what was examined',
    );
  });

  it('resets the rejection list at the start of each search', () => {
    const content = read(HELPER);
    const fn = content.slice(content.search(/function\s+Find-GitBash/i));
    assert.match(
      fn,
      /\$script:GitBashRejected\s*=\s*@\(\)/,
      'a second call in the same session must not inherit the first run’s rejections',
    );
  });
});

describe('interactive-upgrade.ps1 — honest message when Git Bash is unusable', () => {
  it('no longer tells the user to install Git Bash unconditionally', () => {
    const content = read(UPGRADE);
    // Anchored on the emitting statement, not on any occurrence of the words: the comment
    // above the fix quotes the old sentence on purpose, and matching that would be a test
    // that fails for the wrong reason.
    assert.doesNotMatch(
      content,
      /Step\s+"verify_local"\s+"Git Bash not found/,
      'that sentence is false on a machine that has Git Bash, and it was the only output produced',
    );
  });

  it('renders the search report in the skip message', () => {
    const content = read(UPGRADE);
    assert.match(
      content,
      /Get-GitBashSearchReport/,
      'the skip message must carry the reason the helper produced',
    );
  });

  it('reports the skip to the server', () => {
    const content = read(UPGRADE);
    assert.match(
      content,
      /upgrade_git_bash_not_usable/,
      'a silently skipped verification step must leave an observation behind',
    );
  });

  it('falls back to a plain reason when the helper itself is missing', () => {
    const content = read(UPGRADE);
    assert.match(
      content,
      /helper not present at/,
      'Get-GitBashSearchReport does not exist if the helper failed to load',
    );
  });

  it('folds the reason to one line before reporting it', () => {
    // The reason is assembled from `bash --version` output and exception messages, one entry
    // per rejected candidate. A newline in it makes the report invalid JSON and the server
    // drops the whole thing, which is the silent loss v1.26.98 was about. Read the variables
    // out of the Detail rather than naming them, so a rename cannot walk away from the check.
    const content = read(UPGRADE);
    const call = /Report-Error -Kind "upgrade_git_bash_not_usable" -Detail "([^"]*)"/.exec(content);
    assert.ok(call, 'the skipped verify must still be reported');
    const interpolated = call[1].match(/\$\w+/g) || [];
    assert.ok(interpolated.length, 'the Detail must carry the reason, not a fixed sentence');
    for (const name of interpolated) {
      assert.match(
        content,
        new RegExp(`\\${name}\\s*=\\s*ConvertTo-OneLine\\b`),
        `${name} reaches the report unfolded; one newline in it loses the entire report`,
      );
    }
  });
});

describe('find-git-bash.ps1 — run as shipped', { skip: powershell ? false : 'no PowerShell on this host' }, () => {
  /**
   * Write a stub that prints one `bash --version` line and exits with a chosen code, in
   * whatever form the host can execute: a .cmd on Windows, a shell script elsewhere.
   */
  function stubBash(dir, name, versionLine, exitCode) {
    if (process.platform === 'win32') {
      const file = path.join(dir, `${name}.cmd`);
      fs.writeFileSync(file, `@echo off\r\necho ${versionLine}\r\nexit /b ${exitCode}\r\n`);
      return file;
    }
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\necho '${versionLine}'\nexit ${exitCode}\n`, { mode: 0o755 });
    return file;
  }

  /** Dot-source the shipped helper and ask it about each stub. Returns one verdict per case. */
  function verdicts(cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-gitbash-'));
    try {
      const paths = cases.map((c) => stubBash(dir, c.name, c.versionLine, c.exitCode));
      const script = [
        `. ${JSON.stringify(path.join(repoRoot, HELPER))}`,
        ...paths.map((p) => `if (Test-IsGitBash -BashPath ${JSON.stringify(p)}) { 'true' } else { 'false' }`),
      ].join('\n');
      const run = spawnSync(powershell, ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        // The helper builds its cache path from USERPROFILE at load. Point it at the temp
        // directory so a test run can never touch the real ~/.ownmind/.git-bash-path.
        env: { ...process.env, USERPROFILE: dir },
      });
      assert.equal(run.status, 0, `PowerShell exited ${run.status}: ${run.stderr}`);
      return run.stdout.trim().split(/\r?\n/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('accepts a real Git Bash on both sides of the 2.55 triplet change', () => {
    const cases = [
      { name: 'git255', versionLine: 'GNU bash, version 5.3.15(1)-release (x86_64-pc-cygwin)', exitCode: 0, want: 'true' },
      { name: 'git254', versionLine: 'GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)', exitCode: 0, want: 'true' },
      { name: 'wsl', versionLine: 'GNU bash, version 5.0.17(1)-release (x86_64-pc-linux-gnu)', exitCode: 0, want: 'false' },
      { name: 'relay', versionLine: 'WSL ERROR: CreateProcessEntryCommon execvpe /bin/bash failed', exitCode: 1, want: 'false' },
      { name: 'unknown', versionLine: 'something that is not bash', exitCode: 0, want: 'false' },
    ];
    assert.deepEqual(
      verdicts(cases),
      cases.map((c) => c.want),
      'cygwin (2.55+) and msys (2.54 and earlier) are both Git Bash; a WSL distro, a failing relay and an unrecognised build are not',
    );
  });
});
