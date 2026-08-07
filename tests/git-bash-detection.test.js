import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
 * These are text assertions on the shipped .ps1, matching how the rest of the
 * PowerShell surface is covered in this repo (the test host is not Windows).
 */

const HELPER = 'scripts/windows/lib/find-git-bash.ps1';
const UPGRADE = 'scripts/interactive-upgrade.ps1';

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

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
});
