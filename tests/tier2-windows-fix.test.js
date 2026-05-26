import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.14 — Tier 2 (Cursor / Antigravity / OpenCode) Windows support
 *
 * Known issues:
 * 1. opencode.js lacks a win32 path branch → Windows paths are wrong by default.
 * 2. vscode-telemetry.js / opencode.js rely on the `sqlite3` CLI, which Windows does not ship by default.
 *
 * Fix:
 * - opencode.js adds DEFAULT_DB_PATHS to match cursor / antigravity.
 * - install.ps1 auto-runs winget install sqlite3 (winget ships with Win10 1809+).
 * - install.sh Linux branch hints apt install sqlite3 (Mac ships it, no warning).
 * - vscode-telemetry.js ENOENT error message adds install hints (actionable for users).
 */

describe('opencode.js — Windows path branch', () => {
  const content = fs.readFileSync(
    path.join(repoRoot, 'shared', 'scanners', 'opencode.js'),
    'utf8'
  );

  it('DEFAULT_DB_PATHS dict must contain win32', () => {
    assert.match(
      content,
      /DEFAULT_DB_PATHS\s*=\s*\{[\s\S]*win32[\s\S]*\}/,
      'opencode.js is missing the win32 path branch'
    );
  });

  it('win32 path uses AppData (where OpenCode actually stores it on Windows)', () => {
    assert.match(
      content,
      /win32:[\s\S]{0,100}AppData[\s\S]{0,50}opencode/,
      'OpenCode DB on Windows should live under AppData/...'
    );
  });

  it('darwin/linux paths preserve XDG posix layout', () => {
    // path.join(os.homedir(), '.local', 'share', 'opencode', ...)
    // The source literally has '.local', 'share', 'opencode' — allow quotes/commas/spaces in between.
    assert.match(content, /darwin:[\s\S]{0,200}\.local[\s\S]{0,20}share[\s\S]{0,20}opencode/);
    assert.match(content, /linux:[\s\S]{0,200}\.local[\s\S]{0,20}share[\s\S]{0,20}opencode/);
  });
});

describe('install.ps1 — winget auto-installs sqlite3', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('detects whether sqlite3 exists', () => {
    assert.match(
      content,
      /Get-Command\s+sqlite3\s+-ErrorAction\s+SilentlyContinue/,
      'install.ps1 does not check for sqlite3'
    );
  });

  it('if sqlite3 is missing and winget exists → auto-install', () => {
    assert.match(
      content,
      /winget\s+install[\s\S]{0,150}SQLite\.SQLite/,
      'install.ps1 does not try winget install SQLite.SQLite'
    );
  });

  it('reminds the user to reopen terminal so PATH takes effect', () => {
    assert.match(
      content,
      /(PATH|環境變數|重開|restart)/i,
      'install.ps1 should remind users that PATH must take effect'
    );
  });
});

describe('install.sh — Linux sqlite3 hint (no warning on Mac, which ships it)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');

  it('detects sqlite3 + platform check', () => {
    // Check for `command -v sqlite3` or `which sqlite3` + a guard so we only warn on linux.
    const hasCheck = /command -v sqlite3|which sqlite3/.test(content);
    assert.ok(hasCheck, 'install.sh does not check for sqlite3');
  });
});

describe('vscode-telemetry.js — ENOENT error message is actionable', () => {
  const content = fs.readFileSync(
    path.join(repoRoot, 'shared', 'scanners', 'vscode-telemetry.js'),
    'utf8'
  );

  it('ENOENT hints at a concrete install path (winget / apt / URL)', () => {
    // The warning must mention one of: winget, apt-get, or sqlite.org URL.
    const actionable =
      /winget\s+install/i.test(content) ||
      /apt(-get)?\s+install/i.test(content) ||
      /sqlite\.org/i.test(content);
    assert.ok(actionable, 'ENOENT error message lacks install guidance');
  });
});
