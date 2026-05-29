import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.12 — install.ps1 must verify the task really registered after calling register-scanner-task.ps1
 *
 * Codex adversarial review pointed out: install.ps1 currently calls `register-scanner-task.ps1`
 * then silently prints "Task Scheduler registered", ignoring the child exit code / Get-ScheduledTask.
 * Bob once had a bad Duration format; the install side looked OK but the task was never created.
 */

describe('install.ps1 — scanner task registration check', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('must check $LASTEXITCODE after calling register-scanner-task.ps1', () => {
    // Find the block where `register-scanner-task.ps1` appears; within the next 400 chars it must check the exit code
    // or have a Get-ScheduledTask verification
    const callSite = content.indexOf('register-scanner-task.ps1');
    assert.ok(callSite > 0, 'install.ps1 要呼叫 register-scanner-task.ps1');
    const window = content.slice(callSite, callSite + 600);
    const hasCheck =
      /\$LASTEXITCODE/.test(window) ||
      /Get-ScheduledTask[\s\S]{0,120}(OwnMind|Usage\s+Scanner)/.test(window);
    assert.ok(
      hasCheck,
      'install.ps1 未檢查 register-scanner-task.ps1 的 exit code 或 Get-ScheduledTask，silent fail 讓 Bob 類問題很難診斷'
    );
  });
});
