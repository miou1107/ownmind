/**
 * v1.19.7 — session-counter block_count 純函式測試
 *
 * 對應 openspec/changes/v1.20-iron-rule-enforcement/spec.md 場景 16、
 * tasks.md v1.19.7「reply-lint hook 切擋下模式（exit 2）+ 連續 3 次降警告」。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  readCounter,
  incrementCounter,
  readBlockCount,
  incrementBlockCount,
  resetBlockCount,
  _resetCounterPathForTests,
} from '../hooks/lib/session-counter.js';

let tmpCounterPath;

beforeEach(() => {
  tmpCounterPath = path.join(
    os.tmpdir(),
    `session-counter-block-test-${Date.now()}-${Math.random()}.json`
  );
  _resetCounterPathForTests(tmpCounterPath);
});

afterEach(() => {
  try { fs.unlinkSync(tmpCounterPath); } catch { /* ignore */ }
  _resetCounterPathForTests(null);
});

describe('v1.19.7 — readBlockCount', () => {
  it('未存在的 session 回 0', () => {
    assert.equal(readBlockCount('s1'), 0);
  });

  it('已 increment 後正確讀回', () => {
    incrementBlockCount('s1');
    incrementBlockCount('s1');
    assert.equal(readBlockCount('s1'), 2);
  });

  it('檔毀損 → 視為 0、不丟', () => {
    fs.mkdirSync(path.dirname(tmpCounterPath), { recursive: true });
    fs.writeFileSync(tmpCounterPath, '!!! not json');
    assert.equal(readBlockCount('s1'), 0);
  });

  it('sessionId 非字串 → 回 0、不丟', () => {
    assert.equal(readBlockCount(null), 0);
    assert.equal(readBlockCount(42), 0);
    assert.equal(readBlockCount(undefined), 0);
  });
});

describe('v1.19.7 — incrementBlockCount', () => {
  it('未存在 session → 建檔、block_count=1', () => {
    const v = incrementBlockCount('s1');
    assert.equal(v, 1);
    const data = JSON.parse(fs.readFileSync(tmpCounterPath, 'utf8'));
    assert.equal(data.s1.block_count, 1);
    assert.equal(data.s1.count, 0);
    assert.ok(data.s1.started_at);
    assert.match(data.s1.last_block_ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('連續 increment 累積', () => {
    assert.equal(incrementBlockCount('s1'), 1);
    assert.equal(incrementBlockCount('s1'), 2);
    assert.equal(incrementBlockCount('s1'), 3);
  });

  it('既有 session（有 count 沒 block_count）→ 安全新增 block_count 欄位', () => {
    // 模擬從 v1.19.6 升上來的舊資料、沒 block_count
    fs.mkdirSync(path.dirname(tmpCounterPath), { recursive: true });
    fs.writeFileSync(
      tmpCounterPath,
      JSON.stringify({
        s1: {
          count: 5,
          last_violation_ts: '2026-05-22T00:00:00.000Z',
          started_at: '2026-05-22T00:00:00.000Z',
        },
      })
    );
    const v = incrementBlockCount('s1');
    assert.equal(v, 1);
    const data = JSON.parse(fs.readFileSync(tmpCounterPath, 'utf8'));
    assert.equal(data.s1.count, 5, '不該動 violation count');
    assert.equal(data.s1.block_count, 1);
  });

  it('增 block 不影響 violation count（incrementCounter 跟 incrementBlockCount 獨立）', () => {
    incrementCounter('s1');
    incrementCounter('s1');
    incrementBlockCount('s1');
    assert.equal(readCounter('s1'), 2);
    assert.equal(readBlockCount('s1'), 1);
  });

  it('不同 session 計數獨立', () => {
    incrementBlockCount('a');
    incrementBlockCount('b');
    incrementBlockCount('b');
    assert.equal(readBlockCount('a'), 1);
    assert.equal(readBlockCount('b'), 2);
  });

  it('sessionId 非字串 → 回 0、不丟、不寫檔', () => {
    assert.equal(incrementBlockCount(null), 0);
    assert.equal(fs.existsSync(tmpCounterPath), false);
  });
});

describe('v1.19.7 — resetBlockCount', () => {
  it('清零既有 block_count（不動 violation count）', () => {
    incrementCounter('s1');
    incrementCounter('s1');
    incrementBlockCount('s1');
    incrementBlockCount('s1');
    resetBlockCount('s1');
    assert.equal(readBlockCount('s1'), 0);
    assert.equal(readCounter('s1'), 2, '不該動 violation count');
  });

  it('未存在 session → noop、不丟', () => {
    resetBlockCount('nonexistent');
  });

  it('block_count 已是 0 → noop、不寫檔（避免無謂寫入）', () => {
    incrementCounter('s1'); // 建檔但 block_count 不存在
    const before = fs.statSync(tmpCounterPath).mtimeMs;
    // 跨 ms 確保時間戳會變
    const wait = Date.now() + 5;
    while (Date.now() < wait) { /* spin */ }
    resetBlockCount('s1');
    const after = fs.statSync(tmpCounterPath).mtimeMs;
    assert.equal(after, before, 'block_count=0 時 reset 不該觸發寫檔');
  });

  it('sessionId 非字串 → noop、不丟', () => {
    resetBlockCount(null);
    resetBlockCount(123);
  });
});

describe('v1.19.7 — 防呆：寫入失敗不丟', () => {
  it('寫無權限路徑 incrementBlockCount 不丟', () => {
    _resetCounterPathForTests('/root/cannot-write/x.json');
    let didThrow = false;
    try { incrementBlockCount('s1'); } catch { didThrow = true; }
    assert.equal(didThrow, false);
  });
});
