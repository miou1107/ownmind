import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.12 — install.ps1 呼叫 register-scanner-task.ps1 後必須驗證真的註冊上
 *
 * Codex adversarial review 指出：install.ps1 當前 call `register-scanner-task.ps1`
 * 後 silently 印「Task Scheduler 已註冊」，不管 child exit code / Get-ScheduledTask。
 * Adam 當時 Duration 格式錯誤，安裝端看起來 OK 但 task 根本沒上。
 */

describe('install.ps1 — scanner task registration 檢查', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('呼叫 register-scanner-task.ps1 後要驗 $LASTEXITCODE', () => {
    // 找出現 `register-scanner-task.ps1` 的 block，往後 400 字元內要檢查 exit code
    // 或有 Get-ScheduledTask 驗證
    const callSite = content.indexOf('register-scanner-task.ps1');
    assert.ok(callSite > 0, 'install.ps1 要呼叫 register-scanner-task.ps1');
    const window = content.slice(callSite, callSite + 600);
    const hasCheck =
      /\$LASTEXITCODE/.test(window) ||
      /Get-ScheduledTask[\s\S]{0,120}(OwnMind|Usage\s+Scanner)/.test(window);
    assert.ok(
      hasCheck,
      'install.ps1 未檢查 register-scanner-task.ps1 的 exit code 或 Get-ScheduledTask，silent fail 讓 Adam 類問題很難診斷'
    );
  });
});
