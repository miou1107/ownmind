import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.10 — register-scanner-task.ps1 Duration 修正（回報者 Adam）
 *
 * `[TimeSpan]::MaxValue` 在某些 Windows build 超出 Task Scheduler 可接受範圍，
 * 導致 Register-ScheduledTask 吐「Duration 格式錯誤」→ usage scanner 排程沒註冊上。
 * 推薦改成「足夠大的有限值」例如 36500 天（~100 年），符合 Microsoft docs 建議。
 */

describe('register-scanner-task.ps1 — Duration', () => {
  const content = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'windows', 'register-scanner-task.ps1'),
    'utf8'
  );

  it('不能用 [TimeSpan]::MaxValue 當 RepetitionDuration', () => {
    assert.doesNotMatch(
      content,
      /RepetitionDuration[\s\S]{0,80}\[TimeSpan\]::MaxValue/,
      '[TimeSpan]::MaxValue 在 Task Scheduler 被 reject — 要用有限大值'
    );
  });

  it('要用 New-TimeSpan -Days <large>（>= 1000 天）', () => {
    const match = content.match(
      /RepetitionDuration\s+\(New-TimeSpan\s+-Days\s+(\d+)\)/
    );
    assert.ok(match, '缺 RepetitionDuration (New-TimeSpan -Days N) 寫法');
    const days = parseInt(match[1], 10);
    assert.ok(days >= 1000, `Days=${days} 太小；推薦 36500 (100 年)`);
  });
});
