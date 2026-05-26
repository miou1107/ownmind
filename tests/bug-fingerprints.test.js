import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUG_FINGERPRINT_REGISTRY,
  getFingerprintMetadata,
  isValidFingerprint,
  fingerprintsByPrefix,
} from '../shared/bug-fingerprints.js';

// ============================================================
// 註冊表是程式碼層級的列舉、新指紋必須登錄才能用
// ============================================================

test('註冊表是物件、不是空的', () => {
  assert.equal(typeof BUG_FINGERPRINT_REGISTRY, 'object');
  assert.ok(Object.keys(BUG_FINGERPRINT_REGISTRY).length > 0);
});

test('每筆指紋都有 category + description 兩個欄位', () => {
  for (const [key, meta] of Object.entries(BUG_FINGERPRINT_REGISTRY)) {
    assert.ok(meta.category, `${key} 缺 category`);
    assert.ok(meta.description, `${key} 缺 description`);
  }
});

test('指紋名格式：<前綴>_<情境>、前綴只能是合法分類', () => {
  const validPrefixes = ['mem', 'srv_err', 'clt', 'lint', 'sync', 'auth'];
  for (const key of Object.keys(BUG_FINGERPRINT_REGISTRY)) {
    const prefix = key.startsWith('srv_err_') ? 'srv_err' : key.split('_')[0];
    assert.ok(
      validPrefixes.includes(prefix),
      `${key} 的前綴 ${prefix} 不在合法清單`
    );
  }
});

test('指紋名只用小寫英文 / 數字 / 底線、不含時間或 id', () => {
  for (const key of Object.keys(BUG_FINGERPRINT_REGISTRY)) {
    assert.match(key, /^[a-z0-9_]+$/, `${key} 含非法字元`);
    assert.doesNotMatch(key, /\d{8,}/, `${key} 看起來像含時間戳`);
  }
});

// ============================================================
// 查詢 API
// ============================================================

test('getFingerprintMetadata 回傳註冊資料', () => {
  const meta = getFingerprintMetadata('mem_blocked_secret_keyword');
  assert.ok(meta);
  assert.equal(meta.category, 'mem');
});

test('getFingerprintMetadata 對未註冊指紋回 null', () => {
  assert.equal(getFingerprintMetadata('not_registered_xxx'), null);
  assert.equal(getFingerprintMetadata(''), null);
  assert.equal(getFingerprintMetadata(null), null);
  assert.equal(getFingerprintMetadata(undefined), null);
});

test('isValidFingerprint 對註冊過的回 true', () => {
  assert.equal(isValidFingerprint('mem_blocked_secret_keyword'), true);
});

test('isValidFingerprint 對沒註冊的回 false', () => {
  assert.equal(isValidFingerprint('not_registered_xxx'), false);
  assert.equal(isValidFingerprint(''), false);
  assert.equal(isValidFingerprint(null), false);
});

test('fingerprintsByPrefix 回該分類下所有指紋', () => {
  const memFps = fingerprintsByPrefix('mem');
  assert.ok(Array.isArray(memFps));
  assert.ok(memFps.length > 0);
  for (const fp of memFps) {
    assert.ok(fp.startsWith('mem_'), `${fp} 應該以 mem_ 開頭`);
  }
});

test('fingerprintsByPrefix 對不存在分類回空陣列', () => {
  assert.deepEqual(fingerprintsByPrefix('xxxxx'), []);
});

// ============================================================
// 第一階段必須包含的指紋（規格場景對應）
// ============================================================

test('包含 spec.md 場景提到的 mem_blocked_secret_keyword', () => {
  assert.ok(isValidFingerprint('mem_blocked_secret_keyword'));
});

test('包含 5xx 通用後端錯誤（給全域 5xx handler 用）', () => {
  // 至少要有一個 srv_err_ 前綴的指紋
  const srvErrors = Object.keys(BUG_FINGERPRINT_REGISTRY).filter(k => k.startsWith('srv_err_'));
  assert.ok(srvErrors.length > 0, '需要至少一個 srv_err_ 指紋給 5xx handler 用');
});

// v1.26.1: free-form escape hatch fingerprint must be registered.
test('v1.26.1: clt_user_reported_other is registered as the free-form escape hatch', () => {
  assert.equal(isValidFingerprint('clt_user_reported_other'), true);
  const meta = getFingerprintMetadata('clt_user_reported_other');
  assert.ok(meta);
  assert.equal(meta.category, 'clt');
  assert.match(meta.description, /free-form|user-initiated|design issue/i);
});

// ============================================================
// 穩定性：指紋是常數、不該包含動態值
// ============================================================

test('指紋裡不含時間戳格式（例：YYYY-MM-DD、ISO）', () => {
  for (const key of Object.keys(BUG_FINGERPRINT_REGISTRY)) {
    assert.doesNotMatch(key, /20\d{2}/, `${key} 看起來含年份`);
  }
});

test('指紋裡不含 UUID 樣式', () => {
  for (const key of Object.keys(BUG_FINGERPRINT_REGISTRY)) {
    assert.doesNotMatch(
      key,
      /[0-9a-f]{8}-[0-9a-f]{4}/i,
      `${key} 看起來含 UUID`
    );
  }
});
