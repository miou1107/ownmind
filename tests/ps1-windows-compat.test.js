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
//   openspec/changes/archive/v1.17.66-windows-hardening/proposal.md
//
// 修法的 GIVEN/WHEN/THEN：
//   openspec/changes/archive/v1.17.66-windows-hardening/spec.md
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

  // v1.17.67 修：v1.17.66 想加電池友善設定，但 -DontStartIfOnBatteries
  // 和 -StopIfGoingOnBatteries 都不是 New-ScheduledTaskSettingsSet 的合法參數
  // （正確名是 -DisallowStartIfOnBatteries / -DontStopIfGoingOnBatteries），
  // 在 PS 5.1 + PS 7 都直接 throw → task 完全沒註冊（Adam / Eric 兩台中標）。
  // 而且 PowerShell 預設行為本來就是「電池上不啟動 + 切電池就停」，這兩個
  // 顯式設定其實多餘，乾脆刪掉。
  it('register-scanner-task.ps1 不可包含 v1.17.66 拼錯的兩個 battery 參數', () => {
    const content = readPs1('scripts/windows/register-scanner-task.ps1');
    // 剝掉 PowerShell 行註解（# ... 到行尾），避免註解裡為了說明 bug
    // 而提到舊壞 param 名被誤判成實際使用。
    const code = content.replace(/(^|\s)#[^\n]*/g, '$1');
    assert.doesNotMatch(code, /-DontStartIfOnBatteries\b/,
      '-DontStartIfOnBatteries 不是 PowerShell 合法參數（正確：-DisallowStartIfOnBatteries）。' +
      'PS 預設已是「電池上不啟動」，乾脆完全不設。');
    assert.doesNotMatch(code, /-StopIfGoingOnBatteries\b/,
      '-StopIfGoingOnBatteries 不是 PowerShell 合法參數（正確：-DontStopIfGoingOnBatteries 是反向 switch）。' +
      'PS 預設已是「切電池就停」，乾脆完全不設。');
  });

  // IR-007 Persistent Bug Protocol：v1.17.66 原本的 test 只 assert 字串存在於檔案，
  // 字串對 ≠ PowerShell 接受該 param。改用白名單比對防止下次再有人打錯。
  it('register-scanner-task.ps1 New-ScheduledTaskSettingsSet 全部 param 必須是 PowerShell 合法名稱', () => {
    const content = readPs1('scripts/windows/register-scanner-task.ps1');

    // PowerShell 5.1 + 7 共通的 New-ScheduledTaskSettingsSet 合法參數
    // 來源：Microsoft Docs ScheduledTasks module (Windows Server 2012+)
    // 維護策略：新增 param 時必須來自官方文件，並在 PS 5.1 跑過 Get-Help 驗證。
    const VALID_PARAMS = new Set([
      'AllowDemandStart', 'AllowHardTerminate', 'AllowStartIfOnBatteries',
      'Compatibility', 'DeleteExpiredTaskAfter', 'Disable',
      'DisallowDemandStart', 'DisallowHardTerminate', 'DisallowStartIfOnBatteries',
      'DontStopIfGoingOnBatteries', 'DontStopOnIdleEnd',
      'ExecutionTimeLimit', 'Hidden',
      'IdleDuration', 'IdleWaitTimeout',
      'MaintenanceDeadline', 'MaintenanceExclusive', 'MaintenancePeriod',
      'MultipleInstances', 'NetworkId', 'NetworkName',
      'Priority', 'RestartCount', 'RestartInterval', 'RestartOnIdle',
      'RunOnlyIfIdle', 'RunOnlyIfNetworkAvailable',
      'StartWhenAvailable', 'WakeToRun',
    ]);

    // 先剝掉 PowerShell 行註解（# 到行尾），不然 regex 會抓到註解區塊裡為了
    // 解釋而出現的 cmdlet 名稱，把註解內容當實際 cmdlet 區塊驗 → 錯過真 bug
    // （v1.17.67 code review 抓到，注入 -BogusFakeParam 到實際 call test 還是綠）。
    const codeOnly = content.replace(/(^|\s)#[^\n]*/g, '$1');

    // 抓 New-ScheduledTaskSettingsSet 整個 ` 接續多行區塊
    const blockMatch = codeOnly.match(/New-ScheduledTaskSettingsSet[\s\S]*?(?=\n\$|\n\n|\nRegister-)/);
    assert.ok(blockMatch, '找不到 New-ScheduledTaskSettingsSet 區塊');

    // 先剝掉 ( ... ) 內層函式呼叫（如 New-TimeSpan -Minutes 10），
    // 避免把內層 cmdlet 的 param 誤算成 New-ScheduledTaskSettingsSet 的 param。
    let stripped = blockMatch[0];
    let prev;
    do {
      prev = stripped;
      stripped = stripped.replace(/\([^()]*\)/g, '');
    } while (stripped !== prev);

    const usedParams = [...stripped.matchAll(/(?<![\w-])-([A-Z][A-Za-z0-9]+)\b/g)]
      .map((m) => m[1]);

    const unknownParams = usedParams.filter((p) => !VALID_PARAMS.has(p));
    assert.deepEqual(unknownParams, [],
      `register-scanner-task.ps1 用了 PowerShell 不認識的 param：${unknownParams.join(', ')}。` +
      `這些在 PS 5.1 / 7 都會直接 throw、task 完全沒註冊。請對照 Microsoft Docs 修正。`);
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
