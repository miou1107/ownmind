import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * Windows 相容性檢查（v1.17.9，回報者 Adam + Eric）
 *
 * Adam 的 case：從 Git Bash 呼叫 install.ps1 時 `$HOME` 是 POSIX 格式
 * `/c/Users/Adam`，跟 Windows path 串接後變 `C:\c\Users\Adam\...` 怪路徑，
 * node 寫檔到錯地方。Root cause 是 Git Bash 的環境變數污染了 PowerShell 子程序。
 *
 * 修法：每支 .ps1 開頭都要有 normalization preamble，把 `$HOME` 強制指向
 * `$env:USERPROFILE`（Windows 正確格式）。
 *
 * 另外：舊版 interactive-upgrade.ps1 會傳 `--update` 給 install.ps1，被當
 * API key 導致 silent mis-config。install.ps1 要過濾 flag-like args。
 */

const PS1_FILES = [
  'install.ps1',
  'scripts/bootstrap.ps1',
  'scripts/interactive-upgrade.ps1',
  'scripts/windows/register-scanner-task.ps1',
];

function readPs1(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('PS1 Windows 環境正規化 preamble', () => {
  for (const rel of PS1_FILES) {
    it(`${rel} — 含 $HOME → $env:USERPROFILE normalization`, () => {
      const content = readPs1(rel);
      // 兩個必要元素：
      // 1. 檢查 $env:USERPROFILE 存在
      // 2. 覆寫 $HOME（Set-Variable -Name HOME 或 $global:HOME = 或同義）
      assert.match(
        content,
        /\$env:USERPROFILE/,
        `${rel} 缺 $env:USERPROFILE 判斷`
      );
      assert.match(
        content,
        /Set-Variable\s+-Name\s+HOME|\$(?:global:)?HOME\s*=\s*\$env:USERPROFILE/,
        `${rel} 缺 $HOME 覆寫邏輯`
      );
    });
  }
});

describe('install.ps1 — flag-like args 過濾（Adam / Eric workflow 兼容）', () => {
  const content = readPs1('install.ps1');

  it('過濾掉開頭是 - 的 args（如 --update / -u）', () => {
    // 要有類似 `Where-Object { $_ -notlike '-*' }` 的過濾
    assert.match(
      content,
      /Where-Object\s*\{\s*\$_\s+-notlike\s+'-\*'/,
      'install.ps1 未過濾 flag-like args，舊版 interactive-upgrade 傳 --update 會被當 API key'
    );
  });

  it('ApiKey 被過濾後若為空應該 fallback 到環境變數', () => {
    // 驗證過濾過的 args 空時還是會抓 env:OWNMIND_API_KEY
    assert.match(
      content,
      /\$env:OWNMIND_API_KEY/,
      'install.ps1 需要 fallback 讀 env:OWNMIND_API_KEY'
    );
  });
});
