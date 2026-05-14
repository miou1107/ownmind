import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  SAFETY_ALERT_TYPES,
  BULK_READ_THRESHOLD,
  detectCrossUserAccess,
  detectSecretInLogs,
  detectBulkRead,
} = await import('../src/lib/safety-detect.js');

describe('SAFETY_ALERT_TYPES', () => {
  it('包含 4 種告警類型', () => {
    assert.deepEqual([...SAFETY_ALERT_TYPES].sort(), [
      'bulk_read_alert',
      'cross_user_access',
      'private_memory_leak',
      'secret_value_in_logs',
    ]);
  });
});

describe('detectCrossUserAccess', () => {
  it('回傳資料只含自己的記憶 → null', () => {
    const items = [{ user_id: 1, title: 'a' }, { user_id: 1, title: 'b' }];
    assert.equal(detectCrossUserAccess(1, items), null);
  });

  it('回傳資料含別人的記憶 → 回違規詳情', () => {
    const items = [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }];
    const r = detectCrossUserAccess(1, items);
    assert.deepEqual(r.offending_user_ids, [2, 3]);
    assert.equal(r.count, 2);
  });

  it('多筆同一個別人 → user_ids 去重', () => {
    const items = [{ user_id: 2 }, { user_id: 2 }, { user_id: 2 }];
    const r = detectCrossUserAccess(1, items);
    assert.deepEqual(r.offending_user_ids, [2]);
    assert.equal(r.count, 3);
  });

  it('returnedItems 不是 array → null（防呆）', () => {
    assert.equal(detectCrossUserAccess(1, null), null);
    assert.equal(detectCrossUserAccess(1, undefined), null);
    assert.equal(detectCrossUserAccess(1, 'string'), null);
  });

  it('item 沒 user_id → 跳過該筆、不誤報', () => {
    const items = [{ user_id: 1 }, { title: 'no user_id' }, { user_id: 1 }];
    assert.equal(detectCrossUserAccess(1, items), null);
  });

  it('item 是 null → 跳過該筆', () => {
    const items = [{ user_id: 1 }, null, { user_id: 1 }];
    assert.equal(detectCrossUserAccess(1, items), null);
  });

  it('空 array → null', () => {
    assert.equal(detectCrossUserAccess(1, []), null);
  });
});

describe('detectSecretInLogs', () => {
  it('日誌不含任何機密 → null', () => {
    assert.equal(detectSecretInLogs('一般 log 訊息', ['secret123abc']), null);
  });

  it('日誌含機密原文 → 回違規詳情', () => {
    const r = detectSecretInLogs('debug: api_key=mysecret123abc', ['mysecret123abc']);
    assert.equal(r.matched_count, 1);
  });

  it('多個機密同時被洩漏 → matched_count 計多筆', () => {
    const r = detectSecretInLogs('foo abcdefgh1234 bar 5678hijklmno', ['abcdefgh1234', '5678hijklmno']);
    assert.equal(r.matched_count, 2);
  });

  it('機密太短（< 8 字）→ 不檢查、避免誤報', () => {
    assert.equal(detectSecretInLogs('test 1234', ['1234']), null);
  });

  it('logMessage 不是 string → null', () => {
    assert.equal(detectSecretInLogs(null, ['secret123abc']), null);
    assert.equal(detectSecretInLogs(123, ['secret123abc']), null);
  });

  it('secretValues 不是 array → null', () => {
    assert.equal(detectSecretInLogs('log', null), null);
    assert.equal(detectSecretInLogs('log', 'string'), null);
  });

  it('secretValues 含非字串 → 跳過該筆', () => {
    assert.equal(detectSecretInLogs('log normal', [null, 123, 'realsecretXYZ']), null);
  });
});

describe('detectBulkRead', () => {
  it('讀取數低於閾值 → null', () => {
    assert.equal(detectBulkRead(500), null);
  });

  it('讀取數等於閾值 → null（不觸發、要超過才算）', () => {
    assert.equal(detectBulkRead(BULK_READ_THRESHOLD), null);
  });

  it('讀取數超過閾值 → 回違規詳情', () => {
    const r = detectBulkRead(1500);
    assert.equal(r.count, 1500);
    assert.equal(r.threshold, BULK_READ_THRESHOLD);
    assert.equal(r.window_hours, 1);
  });

  it('讀取數是 0 → null', () => {
    assert.equal(detectBulkRead(0), null);
  });

  it('讀取數是負數 → null（防呆）', () => {
    assert.equal(detectBulkRead(-100), null);
  });

  it('非數字 → null', () => {
    assert.equal(detectBulkRead('1500'), null);
    assert.equal(detectBulkRead(null), null);
    assert.equal(detectBulkRead(undefined), null);
  });

  it('支援自訂閾值（100 > 50 → 觸發）', () => {
    const r = detectBulkRead(100, 50);
    assert.notEqual(r, null);
    assert.equal(r.count, 100);
    assert.equal(r.threshold, 50);
  });

  it('支援自訂閾值（30 < 50 → 不觸發）', () => {
    assert.equal(detectBulkRead(30, 50), null);
  });
});
