/**
 * v1.19.7 — privacy-detect pure-function tests
 *
 * Tracks openspec/changes/v1.20-iron-rule-enforcement/spec.md scenario 17.
 *
 * Detects personal-information leaks (identity / contact data) in AI replies,
 * while allowing content the user themselves has prompted (the user proactively
 * shared it, so it does not count as a leak).
 * v1.19.10: event name is neutralized to privacy_check; no longer tied to a
 * specific user's iron-rule code.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectPrivacyLeak } from '../shared/privacy-detect.js';

// ============================================================
// Basic hits
// ============================================================

describe('detectPrivacyLeak — Taiwan national ID', () => {
  it('valid national ID hits (with check digit)', () => {
    // A123456789 is a canonical example with a valid check digit.
    const r = detectPrivacyLeak('使用者身分證是 A123456789。');
    assert.equal(r.detected, true);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].type, 'tw_id');
    assert.equal(r.matches[0].value, 'A123456789');
  });

  it('looks like an ID but check digit is wrong → no hit (avoid false positive)', () => {
    // A123456788 differs from A123456789 in the last digit; check-digit math fails.
    const r = detectPrivacyLeak('代號 A123456788 是內部代碼。');
    assert.equal(r.detected, false);
  });

  it('lowercase letter prefix → no hit (does not match TW ID format)', () => {
    const r = detectPrivacyLeak('檔名 a123456789 是測試。');
    assert.equal(r.detected, false);
  });
});

describe('detectPrivacyLeak — email', () => {
  it('plain email hits', () => {
    const r = detectPrivacyLeak('請寄到 contact@gmail.com 收件。');
    assert.equal(r.detected, true);
    assert.equal(r.matches[0].type, 'email');
    assert.equal(r.matches[0].value, 'contact@gmail.com');
  });

  it('email with subdomain hits', () => {
    const r = detectPrivacyLeak('admin@mail.acme.com 是管理者。');
    assert.equal(r.detected, true);
    assert.equal(r.matches[0].value, 'admin@mail.acme.com');
  });

  it('@ string without TLD → no hit (avoid false positive on user.email object paths)', () => {
    const r = detectPrivacyLeak('變數 user@local 沒網域。');
    assert.equal(r.detected, false);
  });
});

describe('detectPrivacyLeak — Taiwan mobile', () => {
  it('plain digits mobile hits (0912345678)', () => {
    const r = detectPrivacyLeak('我的手機 0912345678 隨時可聯絡。');
    assert.equal(r.detected, true);
    assert.equal(r.matches[0].type, 'phone_tw_mobile');
    assert.equal(r.matches[0].value, '0912345678');
  });

  it('hyphen-separated mobile hits (0912-345-678)', () => {
    const r = detectPrivacyLeak('客服 0912-345-678 來電。');
    assert.equal(r.detected, true);
    assert.equal(r.matches[0].type, 'phone_tw_mobile');
  });

  it('all-same-digit test number 0911111111 → no hit (avoid mock-number false positive)', () => {
    const r = detectPrivacyLeak('測試碼 0911111111 用於 mock。');
    assert.equal(r.detected, false);
  });

  it('digits not starting with 09 → no hit (landline / generic ID)', () => {
    const r = detectPrivacyLeak('編號 0212345678 是公司代碼。');
    assert.equal(r.detected, false);
  });
});

// ============================================================
// User-prompt exception
// ============================================================

describe('detectPrivacyLeak — user-prompt exception', () => {
  it('AI quoting an email the user shared → not a violation', () => {
    const r = detectPrivacyLeak('好的，我寄到 contact@gmail.com', {
      userPrompts: ['請寄到 contact@gmail.com 給我'],
    });
    assert.equal(r.detected, false);
    assert.equal(r.matches.length, 0);
  });

  it('AI quoting a national ID the user shared → not a violation', () => {
    const r = detectPrivacyLeak('A123456789 的查詢結果如下。', {
      userPrompts: ['幫我查 A123456789 這筆資料'],
    });
    assert.equal(r.detected, false);
  });

  it('AI quoting a mobile the user shared → not a violation', () => {
    const r = detectPrivacyLeak('已撥打 0912345678。', {
      userPrompts: ['幫我打 0912345678 看看'],
    });
    assert.equal(r.detected, false);
  });

  it('user shared a different email; AI introduces a new email → still a violation', () => {
    const r = detectPrivacyLeak('建議改寄到 new@acme.com', {
      userPrompts: ['原本是 old@acme.com'],
    });
    assert.equal(r.detected, true);
    assert.equal(r.matches[0].value, 'new@acme.com');
  });

  it('userPrompts empty array → always detected as usual', () => {
    const r = detectPrivacyLeak('信箱 abc@acme.com', { userPrompts: [] });
    assert.equal(r.detected, true);
  });

  it('userPrompts containing non-string noise → safely ignored; other strings still used for exception matching', () => {
    const r = detectPrivacyLeak('信箱 abc@acme.com', {
      userPrompts: [null, 123, 'abc@acme.com'],
    });
    assert.equal(r.detected, false);
  });
});

// ============================================================
// Edge cases and defense in depth
// ============================================================

describe('detectPrivacyLeak — edge inputs', () => {
  it('empty string → detected=false, matches empty array', () => {
    const r = detectPrivacyLeak('');
    assert.equal(r.detected, false);
    assert.deepEqual(r.matches, []);
  });

  it('null → detected=false', () => {
    const r = detectPrivacyLeak(null);
    assert.equal(r.detected, false);
  });

  it('non-string input → detected=false (no throw)', () => {
    const r = detectPrivacyLeak({ foo: 'bar' });
    assert.equal(r.detected, false);
  });

  it('no options → no exception list; detected normally', () => {
    const r = detectPrivacyLeak('A123456789');
    assert.equal(r.detected, true);
  });

  it('same personal info appearing multiple times → deduplicated; reported once', () => {
    const r = detectPrivacyLeak(
      '請寄 abc@acme.com 給 A123456789，副本也寄 abc@acme.com'
    );
    const emails = r.matches.filter((m) => m.type === 'email');
    assert.equal(emails.length, 1, 'duplicate emails should be deduplicated');
  });

  it('hits across multiple types → all listed', () => {
    const r = detectPrivacyLeak(
      'A123456789 / abc@acme.com / 0912345678'
    );
    assert.equal(r.matches.length, 3);
    const types = r.matches.map((m) => m.type).sort();
    assert.deepEqual(types, ['email', 'phone_tw_mobile', 'tw_id']);
  });
});

// ============================================================
// v1.19.7 code-review I-2: email whitelist (example.com / noreply etc. are not personal info)
// ============================================================

describe('detectPrivacyLeak — email whitelist', () => {
  it('example.com suffix → no hit', () => {
    const r = detectPrivacyLeak('參考 user@example.com 範例');
    assert.equal(r.detected, false);
  });

  it('example.org / example.net are also allowed', () => {
    assert.equal(detectPrivacyLeak('foo@example.org').detected, false);
    assert.equal(detectPrivacyLeak('bar@example.net').detected, false);
  });

  it('subdomain ending in the whitelist also allowed (mail.example.com)', () => {
    const r = detectPrivacyLeak('信箱 admin@mail.example.com');
    assert.equal(r.detected, false);
  });

  it('.test / .invalid / .local suffix allowed', () => {
    assert.equal(detectPrivacyLeak('a@x.test').detected, false);
    assert.equal(detectPrivacyLeak('b@y.invalid').detected, false);
    assert.equal(detectPrivacyLeak('c@z.local').detected, false);
  });

  it('localhost suffix allowed', () => {
    assert.equal(detectPrivacyLeak('admin@anything.localhost').detected, false);
  });

  it('noreply / no-reply / donotreply prefix allowed', () => {
    assert.equal(detectPrivacyLeak('noreply@anthropic.com').detected, false);
    assert.equal(detectPrivacyLeak('no-reply@github.com').detected, false);
    assert.equal(detectPrivacyLeak('donotreply@apple.com').detected, false);
  });

  it('noreply followed by dot/underscore/hyphen is still treated as the prefix', () => {
    assert.equal(detectPrivacyLeak('noreply.team@github.com').detected, false);
    assert.equal(detectPrivacyLeak('noreply-team@github.com').detected, false);
    assert.equal(detectPrivacyLeak('noreply_team@github.com').detected, false);
  });

  it('whitelist is case-insensitive', () => {
    assert.equal(detectPrivacyLeak('NoReply@EXAMPLE.com').detected, false);
    assert.equal(detectPrivacyLeak('USER@Example.Org').detected, false);
  });

  it('whitelist must not block real emails (generic domains)', () => {
    assert.equal(detectPrivacyLeak('contact@gmail.com').detected, true);
    assert.equal(detectPrivacyLeak('hello@gmail.com').detected, true);
  });

  it('common CHANGELOG case: Co-Authored-By Claude noreply@anthropic.com → no hit', () => {
    const text = 'Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>';
    const r = detectPrivacyLeak(text);
    assert.equal(r.detected, false);
  });
});

// ============================================================
// False-positive defense (better to miss than to over-block)
// ============================================================

describe('detectPrivacyLeak — false-positive defense', () => {
  it('source code variable user_id without @ must not match email', () => {
    const r = detectPrivacyLeak('const user_id = 12345; const email = "x";');
    assert.equal(r.detected, false);
  });

  it('OpenAI key sk-proj-... must not be miscategorized as an email', () => {
    const r = detectPrivacyLeak('Key: sk-proj-abc123XYZdef456ghi789jkl');
    // Keys are handled by secret-detect; privacy-detect must not match.
    assert.equal(r.detected, false);
  });

  it('generic 10-digit number (not starting with 09) must not be miscategorized as a mobile', () => {
    const r = detectPrivacyLeak('訂單編號 1234567890 處理中。');
    assert.equal(r.detected, false);
  });
});
