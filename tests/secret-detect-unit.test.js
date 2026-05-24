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

  it('content 含 "api_key"（snake case）+ 賦值樣式 + 值 ≥ 8 → 命中', () => {
    // v1.19.13 起 value-side keyword 偵測要求賦值樣式 + 值 ≥ 8 字
    // 短於 8 字的「值」常為 placeholder / form label / 引用、不應誤擋
    const result = detectSecretLike('api_key: abc12345xyz');
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'keyword:api_key');
  });
});

// ============================================================
// v1.19.13 — value-side keyword 偵測收緊（賦值樣式才命中）
// 對應 openspec/changes/v1.19.13-secret-detect-keyword-tighten/spec.md
// ============================================================

describe('v1.19.13 — value-side keyword 賦值樣式才命中（S1）', () => {
  // S1.1 真實踩坑 regression
  it('S1.1：點分隔識別字 anydesk.bot_kkvin.unattended_password → 放行', () => {
    const r = detectSecretLike('anydesk.bot_kkvin.unattended_password');
    assert.equal(r.detected, false, `不該擋、實際 rule=${r.rule}`);
  });

  // S1.2
  it('S1.2：「the password is in the vault」→ 放行', () => {
    const r = detectSecretLike('the password is in the vault');
    assert.equal(r.detected, false, `不該擋、實際 rule=${r.rule}`);
  });

  // S1.3
  it('S1.3：多層點分隔 hermes.telegram.bot_token → 放行', () => {
    const r = detectSecretLike('hermes.telegram.bot_token');
    assert.equal(r.detected, false, `不該擋、實際 rule=${r.rule}`);
  });

  // S1.4
  it('S1.4：process.env.MY_PASSWORD → 放行', () => {
    const r = detectSecretLike('process.env.MY_PASSWORD');
    assert.equal(r.detected, false, `不該擋、實際 rule=${r.rule}`);
  });

  // S1.5 賦值樣式（冒號）命中
  it('S1.5：password: MyP@ssw0rd123 → 命中', () => {
    const r = detectSecretLike('password: MyP@ssw0rd123');
    assert.equal(r.detected, true);
    assert.ok(r.rule.startsWith('keyword:'), `rule 應 keyword: 開頭、實際 ${r.rule}`);
    assert.ok(r.reason.includes('賦值樣式'), `reason 應含「賦值樣式」、實際「${r.reason}」`);
  });

  // S1.6 賦值樣式（等號）命中
  it('S1.6：API_TOKEN=abc123XYZ987 → 命中 keyword:token', () => {
    const r = detectSecretLike('API_TOKEN=abc123XYZ987');
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'keyword:token');
  });

  // S1.7 值 < 8 字放行（避免 form label 誤判）
  it('S1.7：password: hi（值 < 8 字）→ 放行', () => {
    const r = detectSecretLike('password: hi');
    assert.equal(r.detected, false, `不該擋、實際 rule=${r.rule}`);
  });

  // S1.8 引號包圍的值命中
  it('S1.8：secret = "supersecretvalue" → 命中 keyword:secret', () => {
    const r = detectSecretLike('secret = "supersecretvalue"');
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'keyword:secret');
  });

  // S1.9 複合詞（mypassword）不該命中
  it('S1.9：mypassword=hello123（複合詞）→ 放行', () => {
    const r = detectSecretLike('mypassword=hello123');
    assert.equal(r.detected, false, `不該擋、複合詞「mypassword」非密鑰；實際 rule=${r.rule}`);
  });

  // 額外：bearer + JWT 走 regex 不該 keyword
  it('額外：bearer 後接長字串、由 regex 處理（不是 keyword 命中）', () => {
    const r = detectSecretLike(
      'bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    );
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'regex:jwt', 'JWT regex 優先於 keyword');
  });

  // 額外：純 reference 文件，含多個密鑰名稱
  it('額外：reference 文件含多個密鑰名稱（無賦值）→ 全部放行', () => {
    const refDoc =
      '相關 OwnMind secret：\n' +
      '- ssh.bot.kkvin.com.vin.password\n' +
      '- anydesk.bot_kkvin.unattended_password\n' +
      '- hermes.telegram.bot_token';
    const r = detectSecretLike(refDoc);
    assert.equal(r.detected, false, `reference 文件不該擋、實際 rule=${r.rule}`);
  });
});

describe('v1.19.13 — matched_text 回傳（S2）', () => {
  // S2.1
  it('S2.1：keyword 命中時 matched_text 為字串、≤ 80 字', () => {
    const r = detectSecretLike('password: MyP@ssw0rd123');
    assert.equal(r.detected, true);
    assert.equal(typeof r.matched_text, 'string');
    assert.ok(r.matched_text.length > 0);
    assert.ok(r.matched_text.length <= 80, `matched_text 長度 ${r.matched_text.length} 超過 80`);
    assert.ok(
      r.matched_text.toLowerCase().includes('password'),
      `matched_text 應含 password、實際「${r.matched_text}」`
    );
  });

  // S2.2
  it('S2.2：regex 命中時 matched_text 為字串、≤ 80 字', () => {
    const pat = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    const r = detectSecretLike(pat);
    assert.equal(r.rule, 'regex:github_pat');
    assert.equal(typeof r.matched_text, 'string');
    assert.ok(r.matched_text.length <= 80);
    assert.ok(r.matched_text.startsWith('ghp_'));
  });

  // S2.3
  it('S2.3：length heuristic 命中時 matched_text 為字串、≤ 80 字', () => {
    const r = detectSecretLike('abcDEF1234567890XYZ9876543210');
    assert.equal(r.rule, 'heuristic:long_alnum');
    assert.equal(typeof r.matched_text, 'string');
    assert.ok(r.matched_text.length <= 80);
  });

  // S2.4
  it('S2.4：detected=false 時 matched_text 為 undefined', () => {
    const r = detectSecretLike('hello world');
    assert.equal(r.detected, false);
    assert.equal(r.matched_text, undefined);
  });

  // matched_text 截斷：超長密鑰也只回 80 字
  it('額外：超長密鑰 matched_text 截到 80 字', () => {
    const longKey = 'ghp_' + 'a'.repeat(200);
    const r = detectSecretLike(longKey);
    assert.equal(r.detected, true);
    assert.ok(r.matched_text.length <= 80, `截斷失敗、長度 ${r.matched_text.length}`);
  });
});

// ============================================================
// v1.19.13 review fixes — I-1 / I-2 / I-3 regression tests
// ============================================================

describe('v1.19.13 review I-1：title keyword 命中時不洩漏周圍個資', () => {
  it('title 含 password + 相鄰電話／信箱 → matched_text 只回 keyword 字面', () => {
    const r = detectSecretLike('some narrative content', {
      title: '電話 0912345678 password 信箱 user@example.com',
    });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'keyword:password');
    // 重點：matched_text 不該含手機或信箱
    assert.equal(r.matched_text, 'password',
      `matched_text 應該只回 keyword 字面、實際「${r.matched_text}」`);
    assert.ok(!r.matched_text.includes('0912'), 'matched_text 洩漏手機');
    assert.ok(!r.matched_text.includes('@'), 'matched_text 洩漏信箱');
  });

  it('description 含 token + 相鄰 GitHub PAT 字面 → matched_text 只回 keyword', () => {
    const r = detectSecretLike('content', {
      description: 'this is a token ghp_abcdefghij1234567890abcdef',
    });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'keyword:token');
    assert.equal(r.matched_text, 'token');
    assert.ok(!r.matched_text.includes('ghp_'), 'matched_text 洩漏 PAT');
  });

  it('CJK keyword「密碼」命中 → matched_text 回 keyword 字面', () => {
    const r = detectSecretLike('content', { title: '我的 密碼 在 vault' });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'keyword:密碼');
    assert.equal(r.matched_text, '密碼');
  });
});

describe('v1.19.13 review I-2：點分隔識別字要求 ≥ 3 段', () => {
  it('2 段樣式 eyJhbGc...eyJzdW...（被砍 signature 的 JWT）→ 仍被長度啟發式抓', () => {
    // 兩段都 ≥ 20 字、看起來像 base64 token chunk
    const truncatedJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const r = detectSecretLike(truncatedJwt);
    assert.equal(r.detected, true,
      `2 段 base64 樣式不該被當成識別字路徑放掉、實際 rule=${r.rule}`);
    assert.equal(r.rule, 'heuristic:long_alnum');
  });

  it('其他 2 段 base64 樣式 abcdef1234567890.fedcba0987654321 → 仍被擋', () => {
    const r = detectSecretLike('abcdef1234567890ABCDEF.fedcba0987654321XYZ');
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'heuristic:long_alnum');
  });

  it('3 段識別字路徑 anydesk.bot_kkvin.unattended_password → 放行（不變）', () => {
    const r = detectSecretLike('anydesk.bot_kkvin.unattended_password');
    assert.equal(r.detected, false);
  });

  it('3 段 process.env.MY_PASSWORD → 放行（不變）', () => {
    const r = detectSecretLike('process.env.MY_PASSWORD');
    assert.equal(r.detected, false);
  });
});

describe('v1.19.13 review I-3：snake_case 前綴 + keyword 賦值仍命中（設計意圖）', () => {
  it('foo_password=secretvalue123 → 命中（snake_case env var、應擋）', () => {
    const r = detectSecretLike('foo_password=secretvalue123');
    assert.equal(r.detected, true,
      `snake_case 前綴的 password 賦值應該擋、實際 rule=${r.rule}`);
    assert.equal(r.rule, 'keyword:password');
  });

  it('reset_password_token=abc12345xyz → 命中（多重 snake_case、token 也算）', () => {
    const r = detectSecretLike('reset_password_token=abc12345xyz');
    assert.equal(r.detected, true);
    // 兩個 keyword 都可能命中、實作上第一個（password 在 alternation 前）會先
    assert.ok(
      r.rule === 'keyword:password' || r.rule === 'keyword:token',
      `應為 password 或 token、實際 ${r.rule}`
    );
  });

  it('-token=abc12345xyz（hyphen 前綴）→ 命中（kebab-case env var）', () => {
    const r = detectSecretLike('-token=abc12345xyz');
    assert.equal(r.detected, true);
  });

  it('mypassword=12345678（letter 前綴複合詞、總長 < 20）→ keyword 階段放行', () => {
    // 注意：lookbehind 只保護 keyword 偵測階段、不擋長度啟發式
    // 此測試刻意把總長控制在 < 20 字避開長度啟發式、純驗 keyword 階段行為
    const r = detectSecretLike('mypassword=12345678');
    assert.equal(r.detected, false,
      `keyword 階段不該命中、實際 rule=${r.rule}`);
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
