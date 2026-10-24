import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.77 — start.cmd must use a fallback when node is not on PATH
 * (reporter: vin-windows-test, round 2)
 *
 * Root cause (the next layer that v1.17.76 didn't catch):
 *   - v1.17.76's install.ps1 uses Reload-Path during the OwnMind install to locate node ✅
 *   - but winget installs node into C:\Program Files\nodejs\ and does NOT persist it to User PATH
 *   - Claude Code starts before the install, so its process PATH is frozen at launch time
 *   - Claude Code spawns `cmd.exe /c start.cmd` → cmd.exe inherits Claude Code's old PATH
 *     → `where node` misses → MCP server never starts
 *
 * Fix (two layers of defense):
 *   1. start.cmd adds a fallback: where node → C:\Program Files\nodejs\node.exe →
 *      %ProgramFiles%\nodejs\node.exe → %LOCALAPPDATA%\Programs\nodejs\node.exe
 *   2. install.ps1 persists the node install directory into User PATH (next new terminal /
 *      Claude Code restart finds it without relying on the fallback; the fallback still
 *      protects the "user has not restarted yet" window).
 */

describe('mcp/start.cmd — fallback when node is missing (v1.17.77)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'mcp/start.cmd'), 'utf8');

  it('tries `where node` first (fast path when PATH is set)', () => {
    assert.match(
      content,
      /where\s+node/i,
      'keep the existing `where node` lookup as the primary path'
    );
  });

  it('falls back to C:\\Program Files\\nodejs\\node.exe (winget default location)', () => {
    assert.match(
      content,
      /C:\\Program Files\\nodejs\\node\.exe/i,
      'winget OpenJS.NodeJS.LTS installs here by default; real vin-windows-test case'
    );
  });

  it('falls back to %ProgramFiles%\\nodejs (env-var version, compatible with non-C: system drives)', () => {
    assert.match(
      content,
      /%ProgramFiles%\\nodejs|%PROGRAMFILES%\\nodejs/i,
      'users whose system drive is not C: must still find it'
    );
  });

  it('when every fallback fails, echoes the paths it tried (so users can self-debug)', () => {
    // The error must include both a "not found" description and the actual paths tried (multiple echo lines).
    assert.match(content, /not found/i, 'error message must say not found');
    assert.match(content, /Program Files\\nodejs/i, 'error message must list the Program Files\\nodejs path');
  });
});

describe('install.ps1 — no longer writes the node dir into User PATH (zero-touch install)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('does not persist any node directory into User PATH', () => {
    // The v1.17.77 step existed because winget installed node into Program Files without
    // touching the running session's PATH. install.ps1 no longer installs node with winget:
    // a system node is already on PATH, and the private runtime (runtime\\current\\node.exe)
    // is reached by absolute path (start.cmd's first lookup) and by the PATH prepend inside
    // the installer process. Adding the private runtime to the User PATH would shadow the
    // person's own node for every other program.
    assert.doesNotMatch(
      content,
      /SetEnvironmentVariable\(["']Path["']\s*,[^,]+,\s*["']User["']\)/,
      'install.ps1 must not write the User PATH'
    );
  });

  it('start.cmd still has the fallback chain for a system node that is missing from a stale PATH', () => {
    const cmd = fs.readFileSync(path.join(repoRoot, 'mcp/start.cmd'), 'utf8');
    assert.match(cmd, /C:\\Program Files\\nodejs\\node\.exe/i);
  });
});
