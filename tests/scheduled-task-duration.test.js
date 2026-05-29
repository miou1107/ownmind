import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.10 — register-scanner-task.ps1 Duration fix (reported by Adam)
 *
 * `[TimeSpan]::MaxValue` exceeds the range Task Scheduler accepts on some Windows builds,
 * causing Register-ScheduledTask to throw "Duration format error" → the usage scanner
 * schedule never registers. Recommended fix: use a "sufficiently large finite value" such
 * as 36500 days (~100 years), per Microsoft docs guidance.
 */

describe('register-scanner-task.ps1 — Duration', () => {
  const content = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'windows', 'register-scanner-task.ps1'),
    'utf8'
  );

  it('must not use [TimeSpan]::MaxValue as RepetitionDuration', () => {
    assert.doesNotMatch(
      content,
      /RepetitionDuration[\s\S]{0,80}\[TimeSpan\]::MaxValue/,
      '[TimeSpan]::MaxValue 在 Task Scheduler 被 reject — 要用有限大值'
    );
  });

  it('Days is between 1000 and 9999 (v1.17.11 Eric tested upper bound)', () => {
    const match = content.match(
      /RepetitionDuration\s+\(New-TimeSpan\s+-Days\s+(\d+)\)/
    );
    assert.ok(match, '缺 RepetitionDuration (New-TimeSpan -Days N) 寫法');
    const days = parseInt(match[1], 10);
    assert.ok(
      days >= 1000 && days <= 9999,
      `Days=${days} 超出 Task Scheduler COM validator 範圍；` +
      `>= 1000 保足夠長，<= 9999 避 "Duration 超出允許範圍" warning（Eric 回報 36500 會吐）`
    );
  });
});
