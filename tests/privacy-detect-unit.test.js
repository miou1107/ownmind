/**
 * v1.19.7 — privacy-detect 純函式測試
 *
 * 對應 openspec/changes/v1.20-iron-rule-enforcement/spec.md 場景 17、
 * IR-041「不收集使用者隱私，除非跟工作直接相關」。
 *
 * 偵測 AI 回應中的個資外洩（白話：identity / 聯絡資料），
 * 並對「使用者自己 prompt 過的內容」放行（白話：使用者主動分享過、不算外洩）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectPrivacyLeak } from '../shared/privacy-detect.js';

// ============================================================
// 基本命中
// ============================================================

describe('detectPrivacyLeak — 台灣身分證', () => {
  it('合法身分證命中（含檢碼）', () => {
    // A123456789 是經典範例、檢碼合法
    const r = detectPrivacyLeak('使用者身分證是 A123456789。');
    assert.equal(r.detected, true);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].type, 'tw_id');
    assert.equal(r.matches[0].value, 'A123456789');
  });

  it('格式像身分證但檢碼錯 → 不命中（防誤判）', () => {
    // A123456788 與 A123456789 只差最後一碼、檢碼算式失敗
    const r = detectPrivacyLeak('代號 A123456788 是內部代碼。');
    assert.equal(r.detected, false);
  });

  it('小寫字母開頭 → 不命中（不符台灣身分證格式）', () => {
    const r = detectPrivacyLeak('檔名 a123456789 是測試。');
    assert.equal(r.detected, false);
  });
});

describe('detectPrivacyLeak — 電子信箱', () => {
  it('一般信箱命中', () => {
    const r = detectPrivacyLeak('請寄到 vincent@fontrip.com 收件。');
    assert.equal(r.detected, true);
    assert.equal(r.matches[0].type, 'email');
    assert.equal(r.matches[0].value, 'vincent@fontrip.com');
  });

  it('含子網域信箱命中', () => {
    const r = detectPrivacyLeak('admin@mail.fontrip.com 是管理者。');
    assert.equal(r.detected, true);
    assert.equal(r.matches[0].value, 'admin@mail.fontrip.com');
  });

  it('沒 TLD 的 @ 字串 → 不命中（避免 user.email 物件路徑誤判）', () => {
    const r = detectPrivacyLeak('變數 user@local 沒網域。');
    assert.equal(r.detected, false);
  });
});

describe('detectPrivacyLeak — 台灣手機', () => {
  it('純數字手機命中（0912345678）', () => {
    const r = detectPrivacyLeak('我的手機 0912345678 隨時可聯絡。');
    assert.equal(r.detected, true);
    assert.equal(r.matches[0].type, 'phone_tw_mobile');
    assert.equal(r.matches[0].value, '0912345678');
  });

  it('hyphen 分隔手機命中（0912-345-678）', () => {
    const r = detectPrivacyLeak('客服 0912-345-678 來電。');
    assert.equal(r.detected, true);
    assert.equal(r.matches[0].type, 'phone_tw_mobile');
  });

  it('全同尾碼測試號 0911111111 → 不命中（避免假號碼誤判）', () => {
    const r = detectPrivacyLeak('測試碼 0911111111 用於 mock。');
    assert.equal(r.detected, false);
  });

  it('非 09 開頭數字 → 不命中（市話／一般 ID）', () => {
    const r = detectPrivacyLeak('編號 0212345678 是公司代碼。');
    assert.equal(r.detected, false);
  });
});

// ============================================================
// 使用者提問例外
// ============================================================

describe('detectPrivacyLeak — 使用者提問例外', () => {
  it('AI 回覆引用使用者提問裡的信箱 → 不算違反', () => {
    const r = detectPrivacyLeak('好的，我寄到 vincent@fontrip.com', {
      userPrompts: ['請寄到 vincent@fontrip.com 給我'],
    });
    assert.equal(r.detected, false);
    assert.equal(r.matches.length, 0);
  });

  it('AI 回覆引用使用者提問裡的身分證 → 不算違反', () => {
    const r = detectPrivacyLeak('A123456789 的查詢結果如下。', {
      userPrompts: ['幫我查 A123456789 這筆資料'],
    });
    assert.equal(r.detected, false);
  });

  it('AI 回覆引用使用者提問裡的手機 → 不算違反', () => {
    const r = detectPrivacyLeak('已撥打 0912345678。', {
      userPrompts: ['幫我打 0912345678 看看'],
    });
    assert.equal(r.detected, false);
  });

  it('使用者提問裡是「另一個」信箱、AI 給出新的信箱 → 仍算違反', () => {
    const r = detectPrivacyLeak('建議改寄到 new@fontrip.com', {
      userPrompts: ['原本是 old@fontrip.com'],
    });
    assert.equal(r.detected, true);
    assert.equal(r.matches[0].value, 'new@fontrip.com');
  });

  it('userPrompts 為空陣列 → 一律照樣偵測', () => {
    const r = detectPrivacyLeak('信箱 abc@fontrip.com', { userPrompts: [] });
    assert.equal(r.detected, true);
  });

  it('userPrompts 含非字串雜質 → 安全略過、其他字串仍用於例外比對', () => {
    const r = detectPrivacyLeak('信箱 abc@fontrip.com', {
      userPrompts: [null, 123, 'abc@fontrip.com'],
    });
    assert.equal(r.detected, false);
  });
});

// ============================================================
// 邊界與防呆
// ============================================================

describe('detectPrivacyLeak — 邊界輸入', () => {
  it('空字串 → detected=false、matches 空陣列', () => {
    const r = detectPrivacyLeak('');
    assert.equal(r.detected, false);
    assert.deepEqual(r.matches, []);
  });

  it('null → detected=false', () => {
    const r = detectPrivacyLeak(null);
    assert.equal(r.detected, false);
  });

  it('非字串輸入 → detected=false（不丟錯）', () => {
    const r = detectPrivacyLeak({ foo: 'bar' });
    assert.equal(r.detected, false);
  });

  it('沒傳 options → 視為無例外、照樣偵測', () => {
    const r = detectPrivacyLeak('A123456789');
    assert.equal(r.detected, true);
  });

  it('同一筆個資出現多次 → 去重、只報一次', () => {
    const r = detectPrivacyLeak(
      '請寄 abc@fontrip.com 給 A123456789，副本也寄 abc@fontrip.com'
    );
    const emails = r.matches.filter((m) => m.type === 'email');
    assert.equal(emails.length, 1, '重複信箱該去重');
  });

  it('同時命中多種類型 → 全部列出', () => {
    const r = detectPrivacyLeak(
      'A123456789 / abc@fontrip.com / 0912345678'
    );
    assert.equal(r.matches.length, 3);
    const types = r.matches.map((m) => m.type).sort();
    assert.deepEqual(types, ['email', 'phone_tw_mobile', 'tw_id']);
  });
});

// ============================================================
// v1.19.7 code-review I-2：信箱白名單（example.com / noreply 等不算個資）
// ============================================================

describe('detectPrivacyLeak — 信箱白名單', () => {
  it('example.com 結尾 → 不命中', () => {
    const r = detectPrivacyLeak('參考 user@example.com 範例');
    assert.equal(r.detected, false);
  });

  it('example.org / example.net 同樣放行', () => {
    assert.equal(detectPrivacyLeak('foo@example.org').detected, false);
    assert.equal(detectPrivacyLeak('bar@example.net').detected, false);
  });

  it('子網域結尾在白名單也放行（mail.example.com）', () => {
    const r = detectPrivacyLeak('信箱 admin@mail.example.com');
    assert.equal(r.detected, false);
  });

  it('.test / .invalid / .local 結尾放行', () => {
    assert.equal(detectPrivacyLeak('a@x.test').detected, false);
    assert.equal(detectPrivacyLeak('b@y.invalid').detected, false);
    assert.equal(detectPrivacyLeak('c@z.local').detected, false);
  });

  it('localhost 結尾放行', () => {
    assert.equal(detectPrivacyLeak('admin@anything.localhost').detected, false);
  });

  it('noreply / no-reply / donotreply 開頭放行', () => {
    assert.equal(detectPrivacyLeak('noreply@anthropic.com').detected, false);
    assert.equal(detectPrivacyLeak('no-reply@github.com').detected, false);
    assert.equal(detectPrivacyLeak('donotreply@apple.com').detected, false);
  });

  it('noreply 後接點／底線／hyphen 仍視為前綴', () => {
    assert.equal(detectPrivacyLeak('noreply.team@github.com').detected, false);
    assert.equal(detectPrivacyLeak('noreply-team@github.com').detected, false);
    assert.equal(detectPrivacyLeak('noreply_team@github.com').detected, false);
  });

  it('白名單大小寫不敏感', () => {
    assert.equal(detectPrivacyLeak('NoReply@EXAMPLE.com').detected, false);
    assert.equal(detectPrivacyLeak('USER@Example.Org').detected, false);
  });

  it('白名單不該擋真實信箱（一般域名）', () => {
    assert.equal(detectPrivacyLeak('vincent@fontrip.com').detected, true);
    assert.equal(detectPrivacyLeak('hello@gmail.com').detected, true);
  });

  it('CHANGELOG 常見：Co-Authored-By Claude noreply@anthropic.com → 不命中', () => {
    const text = 'Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>';
    const r = detectPrivacyLeak(text);
    assert.equal(r.detected, false);
  });
});

// ============================================================
// 誤判防呆（白話：寧可漏、別誤擋）
// ============================================================

describe('detectPrivacyLeak — 誤判防呆', () => {
  it('程式碼變數 user_id 不含 @ 不該命中 email', () => {
    const r = detectPrivacyLeak('const user_id = 12345; const email = "x";');
    assert.equal(r.detected, false);
  });

  it('OpenAI 金鑰樣式 sk-proj-... 不該被誤判為信箱', () => {
    const r = detectPrivacyLeak('Key: sk-proj-abc123XYZdef456ghi789jkl');
    // 金鑰由 secret-detect 負責、privacy-detect 不該命中
    assert.equal(r.detected, false);
  });

  it('一般 10 碼數字（不是 09 開頭）不該誤判為手機', () => {
    const r = detectPrivacyLeak('訂單編號 1234567890 處理中。');
    assert.equal(r.detected, false);
  });
});
