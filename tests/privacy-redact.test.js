import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactPrivacyPatterns } from '../shared/privacy-redact.js';

// ============================================================
// Basic: email / national ID / phone should all be aliased
// ============================================================

test('plain string: email replaced with alias', () => {
  const { text, replacements } = redactPrivacyPatterns('聯絡 foo@bar.com 即可');
  assert.match(text, /<信箱-001>/);
  assert.doesNotMatch(text, /foo@bar\.com/);
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].type, 'email');
});

test('plain string: Taiwan mobile number replaced with alias', () => {
  const { text } = redactPrivacyPatterns('請打 0912-345-678');
  assert.match(text, /<手機-001>/);
  assert.doesNotMatch(text, /0912-345-678/);
});

test('plain string: national ID replaced with alias', () => {
  // A123456789 is a valid Taiwan national-ID checksum (A=10, computed trailing digit 9)
  const { text } = redactPrivacyPatterns('身分證 A123456789 確認');
  assert.match(text, /<身分證-001>/);
});

// ============================================================
// Same value same alias: a second occurrence of the same email reuses the index
// ============================================================

test('same value appears multiple times, shares one alias', () => {
  const { text } = redactPrivacyPatterns('a@b.com 跟 a@b.com 是同一個人');
  // The email appears twice, both replaced by <信箱-001>
  const matches = text.match(/<信箱-001>/g) || [];
  assert.equal(matches.length, 2);
  assert.doesNotMatch(text, /a@b\.com/);
});

test('different emails increment index', () => {
  const { text } = redactPrivacyPatterns('a@b.com 寫信給 c@d.com');
  assert.match(text, /<信箱-001>/);
  assert.match(text, /<信箱-002>/);
});

test('different types each have their own index', () => {
  const { text } = redactPrivacyPatterns(
    '信箱 a@b.com、手機 0912-345-678、身分證 A123456789'
  );
  assert.match(text, /<信箱-001>/);
  assert.match(text, /<手機-001>/);
  assert.match(text, /<身分證-001>/);
});

// ============================================================
// No match: return as-is
// ============================================================

test('no private-data patterns: return as-is', () => {
  const { text, replacements } = redactPrivacyPatterns('一般文字、沒敏感資料');
  assert.equal(text, '一般文字、沒敏感資料');
  assert.equal(replacements.length, 0);
});

// ============================================================
// Boundaries: empty string, null, non-string types
// ============================================================

test('empty string: return as-is', () => {
  const { text, replacements } = redactPrivacyPatterns('');
  assert.equal(text, '');
  assert.equal(replacements.length, 0);
});

test('null / undefined: return empty result, do not throw', () => {
  assert.doesNotThrow(() => redactPrivacyPatterns(null));
  assert.doesNotThrow(() => redactPrivacyPatterns(undefined));
  const result = redactPrivacyPatterns(null);
  assert.equal(result.text, null);
  assert.deepEqual(result.replacements, []);
});

test('non-string type: return as-is', () => {
  const r1 = redactPrivacyPatterns(123);
  assert.equal(r1.text, 123);
  assert.deepEqual(r1.replacements, []);
});

// ============================================================
// allowlist: fake emails such as example.com should not be aliased (per privacy-detect rules)
// ============================================================

test('example.com fake emails are not private data, no aliasing', () => {
  const { text, replacements } = redactPrivacyPatterns('test@example.com 是假的');
  // Defers to privacy-detect's allowlist result, no aliasing if allowlisted
  assert.equal(replacements.length, 0);
  assert.match(text, /test@example\.com/);
});
