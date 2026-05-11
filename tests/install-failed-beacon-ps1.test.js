import { describe, it, beforeEach, afterEach } from 'node:test';
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
 * v1.17.85 — interactive-upgrade.ps1 Fail 函式 PowerShell smoke test
 *
 * 對應 install-failed-beacon.test.js（bash 版）— 兩端對稱（IR-022）。
 * PowerShell 不可用環境（pwsh 沒裝）→ skip，不擋 CI。
 *
 * 真實意圖：確認 ps1 Fail throw 前真的 call Report-Error，避免 PS 端漏網。
 * 抽 Fail function 的方法跟 bash 版類似 — 從真實 interactive-upgrade.ps1 抽 +
 * dot-source 一個 mock Report-Error stub 紀錄呼叫。
 */

const PWSH = (() => {
  const r = spawnSync('pwsh', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? 'pwsh' : null;
})();

describe('v1.17.85 — interactive-upgrade.ps1 Fail 觀測（pwsh 可用時跑）', { skip: !PWSH }, () => {
  let tmpDir;
  let recordFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-ps1-fail-'));
    recordFile = path.join(tmpDir, 'report-error-calls.txt');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Fail 函式 throw 前先 call Report-Error（不依賴 caller 先 call）', () => {
    // 抽真實的 Fail function 定義 + mock Report-Error 把呼叫寫進 record file
    const ps1Path = path.join(repoRoot, 'scripts', 'interactive-upgrade.ps1');
    const ps1Content = fs.readFileSync(ps1Path, 'utf8');

    // 抓真實的 Fail function 定義（從 'function Fail' 到 closing brace）
    const failMatch = ps1Content.match(/function Fail\([^)]*\)\s*\{[\s\S]*?\n\}/);
    if (!failMatch) {
      assert.fail('找不到 interactive-upgrade.ps1 裡的 function Fail 定義');
    }
    const failDef = failMatch[0];

    const recordFileEscaped = recordFile.replace(/\\/g, '\\\\');
    const fakeScript = [
      '$ErrorActionPreference = "Continue"',
      `$LogFile = "${tmpDir.replace(/\\/g, '\\\\')}\\fake.log"`,
      '"" | Out-File -FilePath $LogFile -Encoding utf8',
      // Mock Report-Error: 把參數寫進 record file
      'function Report-Error {',
      '  param($Kind, $Detail, $ContextFile = "")',
      `  Add-Content -LiteralPath "${recordFileEscaped}" -Value "kind=$Kind|detail=$Detail|context=$ContextFile" -Encoding utf8`,
      '}',
      failDef,
      'try { Fail "no_ownmind" "test detail" } catch { exit 1 }',
    ].join('\n');

    const scriptPath = path.join(tmpDir, 'test.ps1');
    fs.writeFileSync(scriptPath, fakeScript);

    const r = spawnSync(PWSH, ['-NoProfile', '-File', scriptPath], { encoding: 'utf8' });
    assert.equal(r.status, 1, 'Fail throw → catch exit 1');

    const record = fs.readFileSync(recordFile, 'utf8');
    assert.match(record, /kind=upgrade_failed_terminal_no_ownmind/);
    assert.match(record, /detail=test detail/);
  });
});
