import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.76 — 缺 Node.js / git 時 install.ps1 + install.sh 必須自動裝（回報者：vin-windows-test）
 *
 * Root cause：v1.17.75 之前 install.ps1 第 34-37 行對 node 缺失只 Write-Error + exit，
 * 把「裝 Node.js」這步丟回 user（user 沒裝過 Node = 完全卡住）。同檔對 sqlite3
 * （第 42-61 行）已有完整 winget auto-install pattern，pattern 沒套到 node / git。
 *
 * 真實案例的三個 gap（從 vin-windows-test 安裝 log 採證）：
 *   1. node 缺失 → 應該 winget install OpenJS.NodeJS.LTS（fallback 才提示手動）
 *   2. winget 裝完 PATH 在當前 PS session 沒生效 → install.ps1 內必須 reload
 *      Machine + User PATH 後 re-check 一次
 *   3. PowerShell 執行原則擋 npm install → 入口必須 Set-ExecutionPolicy Process Bypass
 *
 * 同樣 pattern 套到 install.sh：缺 node 時用 brew (mac) / apt (linux) 自動裝。
 */

describe('install.ps1 — 缺前置工具時不可只 error exit', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('入口處設 ExecutionPolicy Process Bypass（避免 npm install 被擋）', () => {
    assert.match(
      content,
      /Set-ExecutionPolicy[^\n]*-Scope\s+Process[^\n]*-(ExecutionPolicy\s+)?Bypass/i,
      '必須在 process scope 設 Bypass，否則 user 預設 Restricted 會擋 npm install'
    );
  });

  it('node 缺失時走 winget OpenJS.NodeJS.LTS（不只 Write-Error）', () => {
    // 允許 inline `winget install ... OpenJS.NodeJS.LTS` 或 helper function 帶參數
    // 兩種寫法。重點是 file 必須同時提到 winget install + OpenJS.NodeJS.LTS。
    assert.match(content, /winget\s+install/i, '必須有 winget install 呼叫');
    assert.match(
      content,
      /OpenJS\.NodeJS\.LTS/,
      'Node.js winget package id 必須出現在 install.ps1 (證明有 wire 進去自動裝)'
    );
  });

  it('node 自動裝完必須 reload Machine + User PATH（winget 不會幫當前 session 更新）', () => {
    assert.match(
      content,
      /GetEnvironmentVariable\(["']Path["']\s*,\s*["']Machine["']\)/,
      '要從 Machine + User scope 重組 PATH 才能讓剛裝的 node 在當前 PS session 找到'
    );
    assert.match(
      content,
      /GetEnvironmentVariable\(["']Path["']\s*,\s*["']User["']\)/,
      '同上，User scope PATH 也要併入'
    );
  });

  it('git 缺失時走 winget Git.Git（不只 Write-Error）', () => {
    assert.match(
      content,
      /["']Git\.Git["']/,
      'Git winget package id 必須出現在 install.ps1 (證明有 wire 進去自動裝)'
    );
  });

  it('node 版本必須驗 >= 20（Tier 2 scanner 要求）', () => {
    // install.ps1 內只要對 node --version 做數字比較即可
    assert.match(
      content,
      /node\s+--version|node\.exe\s+-v/,
      '至少要叫一次 node --version 抓版本'
    );
    assert.match(
      content,
      /\b(20|v20|GTE_NODE_MAJOR|NODE_MAJOR)\b/,
      '要把 v20+ 寫進判斷裡'
    );
  });
});

describe('install.sh — 缺 node 時 mac 走 brew、linux 走 apt/dnf', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');

  it('node 缺失時 mac 嘗試 brew install node', () => {
    assert.match(
      content,
      /command -v node[\s\S]*?brew\s+install\s+node/,
      'mac 沒 node 應該嘗試 brew install node（fallback 才提示手動）'
    );
  });

  it('node 缺失時 linux 提示 apt / dnf 安裝指令', () => {
    assert.match(
      content,
      /command -v node[\s\S]*?(apt(-get)?\s+install[^\n]*nodejs|dnf\s+install[^\n]*nodejs)/,
      'linux 沒 node 應該至少提示 apt / dnf 指令（不一定要 sudo 自動裝）'
    );
  });
});
