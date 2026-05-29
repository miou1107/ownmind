import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateMemoryContent } from '../src/utils/memory-secret-guard.js';

/**
 * v1.19.1 — memory-secret-guard integration tests
 *
 * Tracks openspec/changes/v1.19.1-secret-tool-routing/spec.md.
 *
 * validateMemoryContent({ type, title, content, metadata }) wraps secret-detect with
 * memory-type awareness (narrative types like iron_rule / principle skip keyword detection
 * but still run regex to catch literal pasted passwords).
 */

describe('validateMemoryContent — secret detected → 400', () => {
  it('scenario 1: reference type + WP password content → 400', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: 'Example Client WP password',
      content: 'iXEN ops5 pJcy 8PJI lVFM heaH',
      metadata: { description: 'WordPress Application Password' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.redirect_tool, 'ownmind_set_secret');
    assert.ok(result.body.detected_by.startsWith('regex:wp_application_password'));
    assert.ok(result.body.error.length > 0);
    assert.ok(result.body.hint.includes('ownmind_set_secret'));
  });

  it('scenario 2: reference + JWT content → 400 + detected_by=regex:jwt', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: 'API token',
      content:
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.detected_by, 'regex:jwt');
  });

  it('scenario 3: title contains "password" + short content → 400', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: 'Stripe production password',
      content: 'abc123XYZ789longRandomString',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.detected_by, 'keyword:password');
  });

  it('scenario 4: length heuristic (≥ 20 alphanumerics) → 400', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: 'key for service',
      content: 'abcDEF1234567890XYZ9876543210',
    });
    assert.equal(result.ok, false);
    assert.equal(result.body.detected_by, 'heuristic:long_alnum');
  });
});

describe('validateMemoryContent — normal memory → pass', () => {
  it('scenario 5: project type + Chinese content → ok', () => {
    const result = validateMemoryContent({
      type: 'project',
      title: 'Example Client 接手後緊急事項',
      content:
        '2026-05-07 接手後第一週需要處理的緊急事項清單：1. WP backup 2. 員工日誌轉移',
    });
    assert.equal(result.ok, true);
  });

  it('iron_rule type discussing passwords → ok (narrative skips keyword detection)', () => {
    const result = validateMemoryContent({
      type: 'iron_rule',
      title: '不要 commit .env 或密碼',
      content:
        '## 什麼時候適用\ngit commit 前\n## 規則\n不要把密碼、token、API key 寫進 commit。' +
        '字'.repeat(100),
      metadata: {},
    });
    assert.equal(result.ok, true, `iron_rule discussing password should pass, body: ${JSON.stringify(result.body)}`);
  });

  it('principle type narrative containing "password" → ok (narrative skips keyword)', () => {
    const result = validateMemoryContent({
      type: 'principle',
      title: '密碼管理原則',
      content:
        '所有 password 跟 token 必須走 OwnMind secret API、不能 hardcode 在 source code 裡。' +
        '字'.repeat(100),
    });
    assert.equal(result.ok, true);
  });

  it('iron_rule content with a real JWT → still blocked (narrative runs regex too)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = validateMemoryContent({
      type: 'iron_rule',
      title: '不要 commit token',
      content: '## 規則\n例如下面這個 token: ' + jwt + '\n' + '字'.repeat(100),
    });
    assert.equal(result.ok, false, 'even in iron_rule, pasted real JWT must be blocked');
    assert.equal(result.body.detected_by, 'regex:jwt');
  });
});

describe('validateMemoryContent — bypass mechanism', () => {
  it('scenario 6: metadata.allow_secret_like=true → pass + returns lint_warning_entry', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: 'ExampleClient WP password 存放位置',
      content: '存在 1Password 的 "example-prod" vault、entry name="wp-user"',
      metadata: { allow_secret_like: true },
    });
    assert.equal(result.ok, true);
    assert.ok(result.lint_warning_entry, 'should return lint_warning_entry so the caller can write metadata.lint_warnings');
    assert.equal(result.lint_warning_entry.type, 'bypass_secret_detect');
    assert.ok(result.lint_warning_entry.ts, 'must include a timestamp');
  });

  it('bypass allows real JWT content through as well', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = validateMemoryContent({
      type: 'reference',
      title: 'JWT 範例',
      content: jwt,
      metadata: { allow_secret_like: true },
    });
    assert.equal(result.ok, true);
    assert.ok(result.lint_warning_entry);
  });

  it('no metadata → unaffected (no throw)', () => {
    const result = validateMemoryContent({
      type: 'project',
      title: '專案筆記',
      content: '今天做了什麼',
    });
    assert.equal(result.ok, true);
  });
});

describe('validateMemoryContent — edge cases and response shape', () => {
  it('body shape matches the spec', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: 'test',
      content: 'iXEN ops5 pJcy 8PJI lVFM heaH',
    });
    assert.equal(result.ok, false);
    assert.equal(typeof result.body.error, 'string');
    assert.equal(typeof result.body.hint, 'string');
    assert.equal(result.body.redirect_tool, 'ownmind_set_secret');
    assert.equal(typeof result.body.detected_by, 'string');
  });

  it('empty content → pass (nothing to block)', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: 'empty',
      content: '',
    });
    assert.equal(result.ok, true);
  });

  it('null content → pass; no throw', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: 'null content',
      content: null,
    });
    assert.equal(result.ok, true);
  });
});

describe('validateMemoryContent — full coverage over narrative types', () => {
  const narrativeTypes = [
    'iron_rule',
    'principle',
    'coding_standard',
    'team_standard',
    'session_log',
    'standard_detail', // code review I-2 follow-up: team-standard detail is narrative too
    'project',         // v1.19.11 expansion: project notes reference code paths
    'portfolio',       // v1.19.11 expansion: portfolio entries reference implementation details
  ];

  for (const type of narrativeTypes) {
    it(`${type}: title containing "password" is not blocked (skip keyword)`, () => {
      const result = validateMemoryContent({
        type,
        title: `${type} 中討論 password 主題`,
        content: '這是長度足夠的 narrative content、' + '字'.repeat(200),
      });
      assert.equal(result.ok, true, `${type} should pass; keyword must not block`);
    });

    it(`${type}: content containing a real JWT is still blocked (regex not skipped)`, () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = validateMemoryContent({
        type,
        title: 'narrative type with embedded JWT',
        content: jwt,
      });
      assert.equal(result.ok, false, `${type} narrative containing a real JWT must still be blocked`);
    });
  }
});

// v1.19.11 real-world regression: project notes referencing code paths must not be blocked
describe('validateMemoryContent — v1.19.11 real-world regression', () => {
  it('project note containing random-password.js path → not blocked', () => {
    const result = validateMemoryContent({
      type: 'project',
      title: 'v1.19.10 完成紀錄',
      content: '新增 shared/random-password.js 跟 src/routes/admin-password-reset.js、' +
               '對應的 openspec 資料夾在 v1.19.9-password-recovery 跟 v1.19.10-credential-hygiene。'
               + '字'.repeat(50),
    });
    assert.equal(result.ok, true, 'project notes containing code filenames / directory names must not be falsely blocked');
  });

  it('portfolio note containing auth/token technical terms → not blocked', () => {
    const result = validateMemoryContent({
      type: 'portfolio',
      title: '某專案實作回顧',
      content: '用 OAuth token 整合第三方登入、實作位置在 src/auth/token-verify.js。' +
               '字'.repeat(50),
    });
    assert.equal(result.ok, true, 'portfolio notes containing technical terms must not be falsely blocked');
  });

  it('project note containing a real GitHub PAT → still blocked', () => {
    const result = validateMemoryContent({
      type: 'project',
      title: '某專案',
      content: '我把 token 寫進去 ghp_abcdefghijklmnopqrstuvwxyz0123456789AB 看會不會擋',
    });
    assert.equal(result.ok, false, 'even in project, pasted real PAT must be blocked');
  });
});

// ============================================================
// v1.19.13 — matched_text + bot.example.com regression
// Tracks openspec/changes/v1.19.13-secret-detect-keyword-tighten/spec.md
// ============================================================

describe('v1.19.13 — 400 response contains matched_text (S3)', () => {
  // S3.1
  it('S3.1: on hit, 400 body contains matched_text', () => {
    const result = validateMemoryContent({
      type: 'env',
      title: 'test',
      content: 'password: MyP@ssw0rd123',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.ok(result.body.detected_by.startsWith('keyword:'),
      `detected_by should start with keyword:, actual ${result.body.detected_by}`);
    assert.equal(typeof result.body.matched_text, 'string');
    assert.ok(result.body.matched_text.length > 0);
    assert.ok(result.body.matched_text.length <= 80);
  });

  // S3.2
  it('S3.2: dotted identifier anydesk.bot_example.unattended_password → allow (regression)', () => {
    const result = validateMemoryContent({
      type: 'env',
      title: 'test',
      content: 'anydesk.bot_example.unattended_password',
    });
    assert.equal(result.ok, true,
      `should not block, actual body=${result.body ? JSON.stringify(result.body) : 'none'}`);
  });
});

describe('v1.19.13 — bot.example.com full-content regression (S4)', () => {
  // S4.1: the full 2026-05-23/24 conversation content that kept getting blocked
  it('S4.1: bot.example.com remote-access overview full text → allow', () => {
    const content =
      '## bot.example.com 可以怎麼遠端連進來\n\n' +
      '| 方式 | URL / IP / Port | 認證 | 用途 |\n' +
      '|---|---|---|---|\n' +
      '| **SSH** | `ssh vin@bot.example.com`（port 22）| 密碼 or key | 終端機指令、AI 自動化 |\n' +
      '| **xrdp** | `bot.example.com:3389` | ssh 同密碼 | 圖形桌面 |\n' +
      '| **AnyDesk** | ID `123456789` | unattended password（在 OwnMind `anydesk.bot_example.unattended_password`）| 跨平台桌面 |\n' +
      '| **Tailscale** | bot-example 或 `100.64.0.1` | Tailscale 私網 | 私網存取 |\n' +
      '| **Guacamole** | `https://app.example.com/guacamole/` | Guacamole 自己的帳密 | 瀏覽器內桌面 |\n' +
      '\n## 相關記憶\n\n' +
      '- OwnMind secret：`anydesk.bot_example.unattended_password`、' +
      '`ssh.bot.example.com.vin.password`、`hermes.telegram.bot_token`\n';

    const result = validateMemoryContent({
      type: 'env',
      title: 'bot.example.com 遠端訪問方式總覽',
      content,
    });
    assert.equal(result.ok, true,
      `bot.example.com full text must not be blocked, actual body=${result.body ? JSON.stringify(result.body) : 'none'}`);
  });

  // Extra: env type + real assignment style → still blocked
  it('extra: env type + password: real value → still blocked (avoid over-permissive)', () => {
    const result = validateMemoryContent({
      type: 'env',
      title: 'API 設定',
      content: 'OPENAI_API_KEY=sk-realkey1234567890abcdef',
    });
    assert.equal(result.ok, false, 'env type containing a real API key must still be blocked');
  });
});
