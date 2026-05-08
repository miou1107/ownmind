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

// ============================================================================
// v1.17.66 reproduction tests — Eric / Adam 升 v1.17.65 失敗劇本
// ============================================================================
//
// 七個 bug 的真實證據（log + 程式碼）已記錄於：
//   openspec/changes/v1.17.66-windows-hardening/proposal.md
//
// 修法的 GIVEN/WHEN/THEN：
//   openspec/changes/v1.17.66-windows-hardening/spec.md
//
// 這裡放「修完之後該滿足」的斷言。實作前這些 test 會紅；修完轉綠。
// ============================================================================

describe('v1.17.66 — Bug #1 PowerShell 不能 bare bash（避開 WSL relay）', () => {
  it('scripts/windows/lib/find-git-bash.ps1 helper 存在', () => {
    assert.ok(
      fs.existsSync(path.join(repoRoot, 'scripts/windows/lib/find-git-bash.ps1')),
      'helper 檔不存在；v1.17.66 必須建這個 helper'
    );
  });

  it('find-git-bash.ps1 含 Test-IsGitBash + 排除 System32 WSL relay', () => {
    const content = readPs1('scripts/windows/lib/find-git-bash.ps1');
    assert.match(content, /function\s+Test-IsGitBash/i,
      '需要 Test-IsGitBash function 區分 Git Bash 和 WSL relay');
    assert.match(content, /System32\\bash\.exe/i,
      '需要明確排除 C:\\Windows\\System32\\bash.exe（WSL relay）');
    assert.match(content, /function\s+Find-GitBash/i,
      '需要 Find-GitBash 主函式');
  });

  it('interactive-upgrade.ps1 不再 bare `bash` 直接呼叫 verify script', () => {
    const content = readPs1('scripts/interactive-upgrade.ps1');
    // 修法後應該用 & $BashExe $verifyScript，且 $BashExe 來自 Find-GitBash
    assert.match(content, /Find-GitBash/,
      'interactive-upgrade.ps1 應引用 Find-GitBash helper（不該 bare `bash`，會中 WSL relay）');
    // bare `bash $verifyScript` pattern 應該完全消失
    assert.doesNotMatch(content, /^\s*bash\s+\$verifyScript/m,
      '不該再有 bare `bash $verifyScript`，必須走 Find-GitBash');
  });
});

describe('v1.17.66 — Bug #6 PowerShell Out-File 編碼必為 UTF-8', () => {
  // Eric upgrade-20260508-094901.log 因 Out-File 預設 UTF-16 LE BOM 中文 garbled。
  // 全部 .ps1 的 Out-File / Set-Content / Add-Content 都要帶 -Encoding utf8。
  for (const rel of PS1_FILES) {
    it(`${rel} — Out-File 全部帶 -Encoding utf8`, () => {
      const content = readPs1(rel);
      // 抓所有 Out-File 出現點，每一個後面 50 字元內必須有 -Encoding utf8
      const re = /Out-File[^\n]*/g;
      const matches = content.match(re) || [];
      for (const m of matches) {
        assert.match(m, /-Encoding\s+utf8/i,
          `Out-File 缺 -Encoding utf8（會寫 UTF-16 LE BOM、中文 garbled）：「${m}」`);
      }
    });
  }
});

describe('v1.17.66 — Bug #7 Scanner 隱藏視窗 + Battery settings', () => {
  it('scripts/windows/run-hidden.vbs launcher 存在', () => {
    assert.ok(
      fs.existsSync(path.join(repoRoot, 'scripts/windows/run-hidden.vbs')),
      'VBS launcher 不存在；Scanner 跳視窗修法靠它'
    );
  });

  it('register-scanner-task.ps1 用 wscript.exe + run-hidden.vbs（不直接 -Execute node.exe）', () => {
    const content = readPs1('scripts/windows/register-scanner-task.ps1');
    assert.match(content, /wscript\.exe/i,
      'task action 要改用 wscript.exe（GUI subsystem，不開 console window）');
    assert.match(content, /run-hidden\.vbs/i,
      'task action 要呼叫 run-hidden.vbs launcher');
    // 不該再有「-Execute $NodeBin」直跑 node.exe（會跳 console window）
    const actionLine = content.match(/New-ScheduledTaskAction[\s\S]*?(?=\n\$)/);
    if (actionLine) {
      assert.doesNotMatch(actionLine[0], /-Execute\s+\$NodeBin\b/,
        'task action 不該再 -Execute $NodeBin（node.exe 是 console binary，會跳視窗）');
    }
  });

  it('register-scanner-task.ps1 含 DontStartIfOnBatteries + StopIfGoingOnBatteries（筆電友善）', () => {
    const content = readPs1('scripts/windows/register-scanner-task.ps1');
    assert.match(content, /-DontStartIfOnBatteries/,
      'task settings 要加 -DontStartIfOnBatteries（筆電拔電源不跑）');
    assert.match(content, /-StopIfGoingOnBatteries/,
      'task settings 要加 -StopIfGoingOnBatteries（跑到一半拔電源就停）');
  });

  it('register-scanner-task.ps1 RepetitionInterval 改成 120 分鐘（30→120）', () => {
    const content = readPs1('scripts/windows/register-scanner-task.ps1');
    assert.match(content, /-RepetitionInterval\s+\(New-TimeSpan\s+-Minutes\s+120\)/,
      'RepetitionInterval 應從 30 分鐘改為 120 分鐘（降背景負載）');
    assert.doesNotMatch(content, /-RepetitionInterval\s+\(New-TimeSpan\s+-Minutes\s+30\)/,
      '舊的 30 分鐘間隔應被取代');
  });
});

describe('v1.17.66 — Bug #4 self-check 上傳保證執行（try/finally）', () => {
  it('interactive-upgrade.ps1 self-check 在 try/finally 結構內，verify 失敗也要跑', () => {
    const content = readPs1('scripts/interactive-upgrade.ps1');
    // 修法：self-check.cjs 呼叫要在 finally 區塊，保證即使 verify 失敗 / Fail 退出仍跑
    assert.match(content, /\bfinally\s*\{[\s\S]*self-check\.cjs/,
      'self-check.cjs 必須在 finally 區塊內（保證觀測管道執行 — IR-038）');
  });
});
