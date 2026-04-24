import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.14 — Tier 2 (Cursor / Antigravity / OpenCode) Windows 支援
 *
 * 已知問題：
 * 1. opencode.js 沒 win32 path branch → Windows 路徑先天錯
 * 2. vscode-telemetry.js / opencode.js 靠 `sqlite3` CLI，Windows 預設沒裝
 *
 * 修法：
 * - opencode.js 加 DEFAULT_DB_PATHS 跟 cursor/antigravity 一致
 * - install.ps1 自動 winget install sqlite3（Win10 1809+ 內建 winget）
 * - install.sh Linux 分支提示 apt install sqlite3（Mac 內建不 warn）
 * - vscode-telemetry.js ENOENT 錯誤訊息加裝法（actionable for user）
 */

describe('opencode.js — Windows path branch', () => {
  const content = fs.readFileSync(
    path.join(repoRoot, 'shared', 'scanners', 'opencode.js'),
    'utf8'
  );

  it('要有 DEFAULT_DB_PATHS dict 含 win32', () => {
    assert.match(
      content,
      /DEFAULT_DB_PATHS\s*=\s*\{[\s\S]*win32[\s\S]*\}/,
      'opencode.js 缺 win32 path branch'
    );
  });

  it('win32 路徑用 AppData（OpenCode Windows 實際放法）', () => {
    assert.match(
      content,
      /win32:[\s\S]{0,100}AppData[\s\S]{0,50}opencode/,
      'Windows OpenCode DB 應在 AppData/...'
    );
  });

  it('darwin/linux path 保留 XDG posix', () => {
    // path.join(os.homedir(), '.local', 'share', 'opencode', ...)
    // source 裡是 '.local', 'share', 'opencode' — 允許中間有 quote/comma/space
    assert.match(content, /darwin:[\s\S]{0,200}\.local[\s\S]{0,20}share[\s\S]{0,20}opencode/);
    assert.match(content, /linux:[\s\S]{0,200}\.local[\s\S]{0,20}share[\s\S]{0,20}opencode/);
  });
});

describe('install.ps1 — winget 自動裝 sqlite3', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('偵測 sqlite3 存在', () => {
    assert.match(
      content,
      /Get-Command\s+sqlite3\s+-ErrorAction\s+SilentlyContinue/,
      'install.ps1 沒檢查 sqlite3'
    );
  });

  it('若沒裝 sqlite3 且有 winget → 自動裝', () => {
    assert.match(
      content,
      /winget\s+install[\s\S]{0,150}SQLite\.SQLite/,
      'install.ps1 沒嘗試 winget install SQLite.SQLite'
    );
  });

  it('提示重開 terminal 讓 PATH 生效', () => {
    assert.match(
      content,
      /(PATH|環境變數|重開|restart)/i,
      'install.ps1 應提示 PATH 生效'
    );
  });
});

describe('install.sh — Linux sqlite3 提示（Mac 內建不 warn）', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');

  it('偵測 sqlite3 + 平台判斷', () => {
    // 檢查 command -v sqlite3 或 which sqlite3 + 判斷 linux 才 warn
    const hasCheck = /command -v sqlite3|which sqlite3/.test(content);
    assert.ok(hasCheck, 'install.sh 沒檢查 sqlite3');
  });
});

describe('vscode-telemetry.js — ENOENT 錯誤訊息 actionable', () => {
  const content = fs.readFileSync(
    path.join(repoRoot, 'shared', 'scanners', 'vscode-telemetry.js'),
    'utf8'
  );

  it('ENOENT 提示具體裝法（winget / apt / URL）', () => {
    // warn 訊息要包含 winget / apt-get / 或 sqlite.org URL 之一
    const actionable =
      /winget\s+install/i.test(content) ||
      /apt(-get)?\s+install/i.test(content) ||
      /sqlite\.org/i.test(content);
    assert.ok(actionable, 'ENOENT 錯誤訊息缺裝法指示');
  });
});
