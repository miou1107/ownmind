import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectSecretLike } from '../shared/secret-detect.js';

/**
 * v1.19.1 — secret-detect detector unit tests
 *
 * 對應 openspec/changes/v1.19.1-secret-tool-routing/proposal.md §2.1
 * 偵測順序：bypass → regex → keyword → length heuristic
 */
describe('detectSecretLike — regex 規則', () => {
  it('WP Application Password 格式命中（場景 1）', () => {
    const result = detectSecretLike('iXEN ops5 pJcy 8PJI lVFM heaH');
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'regex:wp_application_password');
  });

  it('JWT 格式命中（場景 2）', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = detectSecretLike(jwt);
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'regex:jwt');
  });

  it('GitHub Personal Access Token（ghp_）命中', () => {
    const pat = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    const result = detectSecretLike(pat);
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'regex:github_pat');
  });

  it('GitHub Server Token（ghs_）命中', () => {
    const pat = 'ghs_abcdefghijklmnopqrstuvwxyz0123456789AB';
    const result = detectSecretLike(pat);
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'regex:github_pat');
  });

  it('AWS Access Key 格式命中', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const result = detectSecretLike(key);
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'regex:aws_access_key');
  });

  it('OpenAI API key 格式命中', () => {
    const key = 'sk-proj-abc123XYZdef456ghi789jkl';
    const result = detectSecretLike(key);
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'regex:openai_api_key');
  });

  // v1.19.10：OwnMind 預定金鑰前綴
  it('OwnMind 預定金鑰 vin-ownmind-admin-2026 命中（incident 字面）', () => {
    const r = detectSecretLike('vin-ownmind-admin-2026');
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'regex:ownmind_predefined_key');
  });

  it('OwnMind 預定金鑰 ownmind-admin-xxx（無 vin- 前綴）也命中', () => {
    const r = detectSecretLike('ownmind-admin-prod2026');
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'regex:ownmind_predefined_key');
  });

  it('OwnMind 其他角色 super / user / api 命中', () => {
    assert.equal(detectSecretLike('ownmind-super-token').detected, true);
    assert.equal(detectSecretLike('ownmind-user-abc1').detected, true);
    assert.equal(detectSecretLike('ownmind-api-xyz9').detected, true);
  });

  it('一般「ownmind」字串（無角色前綴）不誤判', () => {
    const r = detectSecretLike('我用 ownmind 來管理鐵律', { skip_keyword: true });
    assert.equal(r.detected, false);
  });

  // v1.19.10：預設密碼字面樣式
  it('預設密碼 Password42760988 命中（incident 字面）', () => {
    const r = detectSecretLike('Password42760988');
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'regex:default_password_literal');
  });

  it('Password 後接 8 位以上純數字命中', () => {
    assert.equal(detectSecretLike('Password12345678').detected, true);
    assert.equal(detectSecretLike('Password99999999').detected, true);
  });

  it('Password 後接少於 8 位數字不命中（避免誤判 form label）', () => {
    const r = detectSecretLike('Password123', { skip_keyword: true });
    assert.equal(r.detected, false);
  });
});

describe('detectSecretLike — keyword 規則', () => {
  it('title 含 "password" 命中（場景 3）', () => {
    const result = detectSecretLike('abc123XYZ789longRandomString', {
      title: 'Stripe production password',
    });
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'keyword:password');
  });

  it('title 含 "token"（大寫）命中（不分大小寫）', () => {
    const result = detectSecretLike('abc123XYZ789longRandomString', {
      title: 'API TOKEN for prod',
    });
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'keyword:token');
  });

  it('description 含繁中關鍵字「應用程式密碼」命中', () => {
    const result = detectSecretLike('iXENops5pJcy', {
      description: 'WordPress 應用程式密碼',
    });
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'keyword:應用程式密碼');
  });

  it('description 含「存取金鑰」命中', () => {
    const result = detectSecretLike('abc', {
      description: 'AWS 存取金鑰',
    });
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'keyword:存取金鑰');
  });

  it('content 含 "api_key"（snake case）命中', () => {
    const result = detectSecretLike('api_key: abc123');
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'keyword:api_key');
  });
});

describe('detectSecretLike — 長度啟發式', () => {
  it('純英數字 ≥20 字 → 命中（場景 4）', () => {
    const result = detectSecretLike('abcDEF1234567890XYZ9876543210');
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'heuristic:long_alnum');
  });

  it('含中文 → 不命中（場景 5）', () => {
    const result = detectSecretLike(
      '2026-05-07 接手後第一週需要處理的緊急事項清單：1. WP backup ...',
      { title: '好好玩 FUNIT 接手後緊急事項' }
    );
    assert.equal(result.detected, false);
  });

  it('短字串 < 20 → 不命中', () => {
    const result = detectSecretLike('hello world');
    assert.equal(result.detected, false);
  });

  it('長字串但含日文 → 不命中', () => {
    const result = detectSecretLike('abcdefghij日本語テキストklmnopqrstuvwxyz');
    assert.equal(result.detected, false);
  });

  // code review I-1 regression — 純英文筆記不該命中 heuristic
  it('英文筆記含空白 → 不命中（I-1 regression）', () => {
    const cases = [
      'Working on JWT integration today',
      'Update README and FILELIST after refactor done',
      'Need to commit the README updates again',
      'Phase 2 complete need code review next step',
    ];
    for (const value of cases) {
      const result = detectSecretLike(value);
      assert.equal(
        result.detected, false,
        `「${value}」不該被當成密鑰；實際 detected=${result.detected}, rule=${result.rule}`
      );
    }
  });
});

describe('detectSecretLike — bypass', () => {
  it('allow_secret_like=true → 跳過所有偵測（場景 6）', () => {
    const result = detectSecretLike('iXEN ops5 pJcy 8PJI lVFM heaH', {
      allow_bypass: true,
    });
    assert.equal(result.detected, false);
  });

  it('allow_secret_like=true + keyword 命中也跳過', () => {
    const result = detectSecretLike('abc', {
      title: 'production password',
      allow_bypass: true,
    });
    assert.equal(result.detected, false);
  });
});

describe('detectSecretLike — 邊界輸入', () => {
  it('value=null → 不丟、回 detected=false', () => {
    const result = detectSecretLike(null);
    assert.equal(result.detected, false);
  });

  it('value=undefined → 不丟、回 detected=false', () => {
    const result = detectSecretLike(undefined);
    assert.equal(result.detected, false);
  });

  it('value=空字串 → 不丟、回 detected=false', () => {
    const result = detectSecretLike('');
    assert.equal(result.detected, false);
  });

  it('options=undefined（沒傳第二參數）→ 不丟', () => {
    const result = detectSecretLike('hello');
    assert.equal(result.detected, false);
  });

  it('value 是 number 而非 string → 不丟、回 detected=false', () => {
    const result = detectSecretLike(12345);
    assert.equal(result.detected, false);
  });
});

describe('detectSecretLike — 回傳結構', () => {
  it('detected=true 時回傳含 rule + reason', () => {
    const result = detectSecretLike('iXEN ops5 pJcy 8PJI lVFM heaH');
    assert.equal(typeof result.detected, 'boolean');
    assert.equal(typeof result.rule, 'string');
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  });

  it('detected=false 時 rule 為 undefined', () => {
    const result = detectSecretLike('hello world');
    assert.equal(result.detected, false);
    assert.equal(result.rule, undefined);
  });
});

describe('detectSecretLike — 偵測順序', () => {
  it('regex 命中優先於 keyword（先 regex）', () => {
    // value 同時符合 JWT regex 跟 keyword (title 含 token)
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = detectSecretLike(jwt, { title: 'my token' });
    assert.equal(result.rule, 'regex:jwt');
  });

  it('keyword 命中優先於 heuristic（regex 沒命中時）', () => {
    // 長字串 + title 有 password → keyword 優先於 length heuristic
    const result = detectSecretLike('abcDEF1234567890XYZ9876543210', {
      title: 'my password',
    });
    assert.equal(result.rule, 'keyword:password');
  });
});
