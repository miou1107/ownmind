import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.76 — when Node.js / git is missing, install.ps1 + install.sh must auto-install
 * (reporter: vin-windows-test)
 *
 * Root cause: before v1.17.75, install.ps1 lines 34-37 only ran Write-Error + exit
 * when node was missing, pushing "install Node.js" back onto the user (a user who
 * has never installed Node = completely stuck). The same file (lines 42-61) already
 * had a full winget auto-install pattern for sqlite3, but the pattern was never
 * applied to node / git.
 *
 * Three real-world gaps (collected from the vin-windows-test install log):
 *   1. node missing → should `winget install OpenJS.NodeJS.LTS` (fallback hints to install manually).
 *   2. After winget installs, PATH does not take effect in the current PS session →
 *      install.ps1 must reload Machine + User PATH and re-check.
 *   3. PowerShell execution policy blocks `npm install` → the entry must run
 *      `Set-ExecutionPolicy -Scope Process Bypass`.
 *
 * Apply the same pattern to install.sh: when node is missing, auto-install via brew
 * (mac) / apt (linux).
 */

describe('install.ps1 — missing prerequisites must not just error-exit', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('entry sets ExecutionPolicy Process Bypass (so npm install is not blocked)', () => {
    assert.match(
      content,
      /Set-ExecutionPolicy[^\n]*-Scope\s+Process[^\n]*-(ExecutionPolicy\s+)?Bypass/i,
      'must set Bypass at process scope, otherwise the default Restricted policy blocks npm install'
    );
  });

  it('when node is missing, calls winget OpenJS.NodeJS.LTS (not just Write-Error)', () => {
    // Allow both forms: inline `winget install ... OpenJS.NodeJS.LTS`, or a helper
    // function with parameters. What matters is that the file mentions both
    // `winget install` and OpenJS.NodeJS.LTS.
    assert.match(content, /winget\s+install/i, 'must contain a winget install call');
    assert.match(
      content,
      /OpenJS\.NodeJS\.LTS/,
      'the Node.js winget package id must appear in install.ps1 (proves it is wired for auto-install)'
    );
  });

  it('after node is auto-installed, must reload Machine + User PATH (winget does not refresh the current session)', () => {
    assert.match(
      content,
      /GetEnvironmentVariable\(["']Path["']\s*,\s*["']Machine["']\)/,
      'must recompose PATH from Machine + User scopes so the freshly installed node is visible in the current PS session'
    );
    assert.match(
      content,
      /GetEnvironmentVariable\(["']Path["']\s*,\s*["']User["']\)/,
      'same as above — must also merge in User-scope PATH'
    );
  });

  it('when git is missing, calls winget Git.Git (not just Write-Error)', () => {
    assert.match(
      content,
      /["']Git\.Git["']/,
      'the Git winget package id must appear in install.ps1 (proves it is wired for auto-install)'
    );
  });

  it('node version must be checked >= 20 (Tier 2 scanner requirement)', () => {
    // install.ps1 just needs to compare `node --version` numerically.
    assert.match(
      content,
      /node\s+--version|node\.exe\s+-v/,
      'must call `node --version` at least once to capture the version'
    );
    assert.match(
      content,
      /\b(20|v20|GTE_NODE_MAJOR|NODE_MAJOR)\b/,
      'the comparison must encode the v20+ threshold'
    );
  });
});

describe('install.sh — missing node: mac uses brew, linux uses apt/dnf', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');

  it('when node is missing on mac, tries brew install node', () => {
    assert.match(
      content,
      /command -v node[\s\S]*?brew\s+install\s+node/,
      'mac without node should attempt `brew install node` (fall back to manual hint)'
    );
  });

  it('when node is missing on linux, prints apt / dnf install commands', () => {
    assert.match(
      content,
      /command -v node[\s\S]*?(apt(-get)?\s+install[^\n]*nodejs|dnf\s+install[^\n]*nodejs)/,
      'linux without node should at least print apt / dnf commands (sudo auto-install not required)'
    );
  });
});
