/**
 * v1.19.3 — Session counter 純函式測試
 *
 * 對應 openspec/changes/v1.19.3-reply-lint-progressive-block/spec.md
 *   場景 7 / 8 / 14
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  readCounter,
  incrementCounter,
  cleanupStale,
  _resetCounterPathForTests,
} from '../hooks/lib/session-counter.js';

let tmpCounterPath;

beforeEach(() => {
  // 用獨立 temp file、避免汙染真實 ~/.ownmind/logs/
  tmpCounterPath = path.join(os.tmpdir(), `session-counter-test-${Date.now()}-${Math.random()}.json`);
  _resetCounterPathForTests(tmpCounterPath);
});

afterEach(() => {
  try { fs.unlinkSync(tmpCounterPath); } catch { /* ignore */ }
  _resetCounterPathForTests(null); // 還原預設
});

describe('v1.19.3 場景 7 — counter 檔不存在視為 0', () => {
  it('readCounter 對未存在 session 回 0', () => {
    const count = readCounter('session-abc');
    assert.equal(count, 0);
  });

  it('incrementCounter 對未存在 session 寫成 1', () => {
    const newCount = incrementCounter('session-abc');
    assert.equal(newCount, 1);
    assert.equal(readCounter('session-abc'), 1);
  });
});

describe('v1.19.3 場景 8 — counter 檔毀損視為 0、覆寫', () => {
  it('檔內容不是合法 JSON → read 回 0', () => {
    fs.mkdirSync(path.dirname(tmpCounterPath), { recursive: true });
    fs.writeFileSync(tmpCounterPath, 'this is not json {{{');
    const count = readCounter('session-abc');
    assert.equal(count, 0);
  });

  it('檔毀損後 increment 覆寫成乾淨檔', () => {
    fs.mkdirSync(path.dirname(tmpCounterPath), { recursive: true });
    fs.writeFileSync(tmpCounterPath, 'garbage');
    const newCount = incrementCounter('session-abc');
    assert.equal(newCount, 1);
    // 確認檔變回合法 JSON
    const parsed = JSON.parse(fs.readFileSync(tmpCounterPath, 'utf8'));
    assert.equal(parsed['session-abc'].count, 1);
  });
});

describe('v1.19.3 場景 14 — 30 天前 session 自動清', () => {
  it('cleanupStale 移除 maxAgeMs 以前的紀錄', () => {
    const now = Date.now();
    const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000;
    fs.mkdirSync(path.dirname(tmpCounterPath), { recursive: true });
    fs.writeFileSync(tmpCounterPath, JSON.stringify({
      'old-session': { count: 5, last_violation_ts: new Date(now - thirtyOneDaysMs).toISOString(), started_at: new Date(now - thirtyOneDaysMs).toISOString() },
      'fresh-session': { count: 2, last_violation_ts: new Date(now).toISOString(), started_at: new Date(now).toISOString() },
    }));
    cleanupStale(30 * 24 * 60 * 60 * 1000);

    const data = JSON.parse(fs.readFileSync(tmpCounterPath, 'utf8'));
    assert.equal(data['old-session'], undefined, '舊 session 該清掉');
    assert.ok(data['fresh-session'], '新 session 該保留');
  });

  it('cleanupStale 對未存在檔不丟錯', () => {
    // 確認檔不存在
    try { fs.unlinkSync(tmpCounterPath); } catch { /* ignore */ }
    // 不該丟
    cleanupStale(30 * 24 * 60 * 60 * 1000);
  });
});

describe('v1.19.3 基本流程', () => {
  it('連續 increment 同 session 累積', () => {
    assert.equal(incrementCounter('session-x'), 1);
    assert.equal(incrementCounter('session-x'), 2);
    assert.equal(incrementCounter('session-x'), 3);
    assert.equal(readCounter('session-x'), 3);
  });

  it('不同 session 計數獨立', () => {
    incrementCounter('session-a');
    incrementCounter('session-a');
    incrementCounter('session-b');
    assert.equal(readCounter('session-a'), 2);
    assert.equal(readCounter('session-b'), 1);
  });

  it('write 後 last_violation_ts 是 ISO8601 字串', () => {
    incrementCounter('session-y');
    const data = JSON.parse(fs.readFileSync(tmpCounterPath, 'utf8'));
    assert.match(data['session-y'].last_violation_ts, /^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('v1.19.3 防呆 — 寫入失敗不該丟', () => {
  it('write 到無權限路徑、incrementCounter 應吞錯回 1 或 0、不該 throw', () => {
    _resetCounterPathForTests('/root/no-permission/x.json'); // 普通 user 寫不進
    // 不該 throw
    let didThrow = false;
    try { incrementCounter('session-z'); }
    catch { didThrow = true; }
    assert.equal(didThrow, false, 'incrementCounter 寫入失敗時不該 throw');
  });
});
