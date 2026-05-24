import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactPrivacyPatterns } from '../shared/privacy-redact.js';

// ============================================================
// 基本：信箱 / 身分證 / 手機都應該被代稱化
// ============================================================

test('純字串：信箱被換成代稱', () => {
  const { text, replacements } = redactPrivacyPatterns('聯絡 foo@bar.com 即可');
  assert.match(text, /<信箱-001>/);
  assert.doesNotMatch(text, /foo@bar\.com/);
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].type, 'email');
});

test('純字串：台灣手機被換成代稱', () => {
  const { text } = redactPrivacyPatterns('請打 0912-345-678');
  assert.match(text, /<手機-001>/);
  assert.doesNotMatch(text, /0912-345-678/);
});

test('純字串：身分證被換成代稱', () => {
  // A123456789 是合法的身分證檢碼（A=10、計算後尾碼 9）
  const { text } = redactPrivacyPatterns('身分證 A123456789 確認');
  assert.match(text, /<身分證-001>/);
});

// ============================================================
// 同值同代稱：第二次出現同一信箱、編號要一樣
// ============================================================

test('同值出現多次、共用同一代稱', () => {
  const { text } = redactPrivacyPatterns('a@b.com 跟 a@b.com 是同一個人');
  // 信箱出現兩次、都被換成 <信箱-001>
  const matches = text.match(/<信箱-001>/g) || [];
  assert.equal(matches.length, 2);
  assert.doesNotMatch(text, /a@b\.com/);
});

test('不同信箱、編號遞增', () => {
  const { text } = redactPrivacyPatterns('a@b.com 寫信給 c@d.com');
  assert.match(text, /<信箱-001>/);
  assert.match(text, /<信箱-002>/);
});

test('不同類型、各自編號', () => {
  const { text } = redactPrivacyPatterns(
    '信箱 a@b.com、手機 0912-345-678、身分證 A123456789'
  );
  assert.match(text, /<信箱-001>/);
  assert.match(text, /<手機-001>/);
  assert.match(text, /<身分證-001>/);
});

// ============================================================
// 沒命中：原樣回傳
// ============================================================

test('沒個資樣式：原樣回傳', () => {
  const { text, replacements } = redactPrivacyPatterns('一般文字、沒敏感資料');
  assert.equal(text, '一般文字、沒敏感資料');
  assert.equal(replacements.length, 0);
});

// ============================================================
// 邊界：空字串、null、非字串型別
// ============================================================

test('空字串：原樣回傳', () => {
  const { text, replacements } = redactPrivacyPatterns('');
  assert.equal(text, '');
  assert.equal(replacements.length, 0);
});

test('null / undefined：回傳空結果、不丟例外', () => {
  assert.doesNotThrow(() => redactPrivacyPatterns(null));
  assert.doesNotThrow(() => redactPrivacyPatterns(undefined));
  const result = redactPrivacyPatterns(null);
  assert.equal(result.text, null);
  assert.deepEqual(result.replacements, []);
});

test('非字串型別：原樣回傳', () => {
  const r1 = redactPrivacyPatterns(123);
  assert.equal(r1.text, 123);
  assert.deepEqual(r1.replacements, []);
});

// ============================================================
// allowlist：example.com 等假信箱不該被代稱化（沿用 privacy-detect 規則）
// ============================================================

test('example.com 假信箱不算個資、不代稱', () => {
  const { text, replacements } = redactPrivacyPatterns('test@example.com 是假的');
  // 看 privacy-detect 的 allowlist 結果、若 allowlist 包含則不代稱
  assert.equal(replacements.length, 0);
  assert.match(text, /test@example\.com/);
});
