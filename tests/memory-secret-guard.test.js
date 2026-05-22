import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateMemoryContent } from '../src/utils/memory-secret-guard.js';

/**
 * v1.19.1 — memory-secret-guard 整合測試
 *
 * 對應 openspec/changes/v1.19.1-secret-tool-routing/spec.md
 *
 * validateMemoryContent({ type, title, content, metadata }) 包一層 secret-detect、
 * 加上 memory 類型感知（iron_rule / principle 等 narrative 類型跳過 keyword 偵測、
 * 但仍跑 regex 抓真的貼密碼進去的情況）。
 */

describe('validateMemoryContent — 偵測到密碼 → 400', () => {
  it('場景 1: reference 類型 + WP password content → 400', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: '好好玩 FUNIT WP password',
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

  it('場景 2: reference + JWT content → 400 + detected_by=regex:jwt', () => {
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

  it('場景 3: title 含 "password" + 短 content → 400', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: 'Stripe production password',
      content: 'abc123XYZ789longRandomString',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.detected_by, 'keyword:password');
  });

  it('場景 4: 長度啟發式（純英數字 ≥20）→ 400', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: 'key for service',
      content: 'abcDEF1234567890XYZ9876543210',
    });
    assert.equal(result.ok, false);
    assert.equal(result.body.detected_by, 'heuristic:long_alnum');
  });
});

describe('validateMemoryContent — 正常記憶 → 通過', () => {
  it('場景 5: project 類型 + 含中文 content → ok', () => {
    const result = validateMemoryContent({
      type: 'project',
      title: '好好玩 FUNIT 接手後緊急事項',
      content:
        '2026-05-07 接手後第一週需要處理的緊急事項清單：1. WP backup 2. 員工日誌轉移',
    });
    assert.equal(result.ok, true);
  });

  it('iron_rule 類型討論密碼 → ok（narrative 跳 keyword 偵測）', () => {
    const result = validateMemoryContent({
      type: 'iron_rule',
      title: '不要 commit .env 或密碼',
      content:
        '## 什麼時候適用\ngit commit 前\n## 規則\n不要把密碼、token、API key 寫進 commit。' +
        '字'.repeat(100),
      metadata: {},
    });
    assert.equal(result.ok, true, `iron_rule 討論密碼應該通過、body: ${JSON.stringify(result.body)}`);
  });

  it('principle 類型 narrative 含 "password" → ok（narrative 跳 keyword）', () => {
    const result = validateMemoryContent({
      type: 'principle',
      title: '密碼管理原則',
      content:
        '所有 password 跟 token 必須走 OwnMind secret API、不能 hardcode 在 source code 裡。' +
        '字'.repeat(100),
    });
    assert.equal(result.ok, true);
  });

  it('iron_rule 內容含實際 JWT → 仍擋（narrative 也跑 regex）', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = validateMemoryContent({
      type: 'iron_rule',
      title: '不要 commit token',
      content: '## 規則\n例如下面這個 token: ' + jwt + '\n' + '字'.repeat(100),
    });
    assert.equal(result.ok, false, '即使 iron_rule、貼真實 JWT 也要擋');
    assert.equal(result.body.detected_by, 'regex:jwt');
  });
});

describe('validateMemoryContent — bypass 機制', () => {
  it('場景 6: metadata.allow_secret_like=true → 通過 + 回傳 lint_warning_entry', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: 'FUNIT WP password 存放位置',
      content: '存在 1Password 的 "FUNIT-prod" vault、entry name="wp-vin"',
      metadata: { allow_secret_like: true },
    });
    assert.equal(result.ok, true);
    assert.ok(result.lint_warning_entry, '應該回傳 lint_warning_entry 給 caller 寫進 metadata.lint_warnings');
    assert.equal(result.lint_warning_entry.type, 'bypass_secret_detect');
    assert.ok(result.lint_warning_entry.ts, '必須有 timestamp');
  });

  it('bypass 即使 content 是真 JWT 也通過', () => {
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

  it('沒帶 metadata → 不影響（不會丟）', () => {
    const result = validateMemoryContent({
      type: 'project',
      title: '專案筆記',
      content: '今天做了什麼',
    });
    assert.equal(result.ok, true);
  });
});

describe('validateMemoryContent — 邊界與回傳結構', () => {
  it('body 結構符合 spec 規格', () => {
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

  it('content 為空 → 通過（沒內容無從擋）', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: 'empty',
      content: '',
    });
    assert.equal(result.ok, true);
  });

  it('content 為 null → 通過、不丟', () => {
    const result = validateMemoryContent({
      type: 'reference',
      title: 'null content',
      content: null,
    });
    assert.equal(result.ok, true);
  });
});

describe('validateMemoryContent — narrative types 完整覆蓋', () => {
  const narrativeTypes = [
    'iron_rule',
    'principle',
    'coding_standard',
    'team_standard',
    'session_log',
    'standard_detail', // code review I-2 補：團隊標準明細也是 narrative
    'project',         // v1.19.11 擴大：專案紀錄會引用程式碼路徑
    'portfolio',       // v1.19.11 擴大：作品集會引用實作細節
  ];

  for (const type of narrativeTypes) {
    it(`${type}：title 含 "password" 不擋（跳 keyword）`, () => {
      const result = validateMemoryContent({
        type,
        title: `${type} 中討論 password 主題`,
        content: '這是長度足夠的 narrative content、' + '字'.repeat(200),
      });
      assert.equal(result.ok, true, `${type} 應該通過、不該被 keyword 擋`);
    });

    it(`${type}：content 含真 JWT 仍擋（regex 不跳）`, () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = validateMemoryContent({
        type,
        title: 'narrative type with embedded JWT',
        content: jwt,
      });
      assert.equal(result.ok, false, `${type} 即使 narrative、貼真 JWT 也要擋`);
    });
  }
});

// v1.19.11 真實踩坑回歸測試：寫 project 紀錄含程式碼路徑不該被擋
describe('validateMemoryContent — v1.19.11 真實踩坑回歸', () => {
  it('project 紀錄含 random-password.js 路徑 → 不被擋', () => {
    const result = validateMemoryContent({
      type: 'project',
      title: 'v1.19.10 完成紀錄',
      content: '新增 shared/random-password.js 跟 src/routes/admin-password-reset.js、' +
               '對應的 openspec 資料夾在 v1.19.9-password-recovery 跟 v1.19.10-credential-hygiene。'
               + '字'.repeat(50),
    });
    assert.equal(result.ok, true, 'project 紀錄含程式碼檔名跟資料夾名不該被誤擋');
  });

  it('portfolio 紀錄含 auth/token 等技術詞 → 不被擋', () => {
    const result = validateMemoryContent({
      type: 'portfolio',
      title: '某專案實作回顧',
      content: '用 OAuth token 整合第三方登入、實作位置在 src/auth/token-verify.js。' +
               '字'.repeat(50),
    });
    assert.equal(result.ok, true, 'portfolio 紀錄含技術詞不該被誤擋');
  });

  it('project 紀錄含真 GitHub PAT → 仍被擋', () => {
    const result = validateMemoryContent({
      type: 'project',
      title: '某專案',
      content: '我把 token 寫進去 ghp_abcdefghijklmnopqrstuvwxyz0123456789AB 看會不會擋',
    });
    assert.equal(result.ok, false, '即使 project、貼真 PAT 也要擋');
  });
});
