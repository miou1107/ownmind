import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lintIronRule, lintSkillMdRule } from '../src/utils/iron-rule-quality.js';
import { detectFrontmatter } from '../src/utils/iron-rule-frontmatter.js';

/**
 * v1.18.0 — SKILL.md schema lint S1-S9 tests (spec.md §1.3)
 *
 * Design: lintIronRule detects frontmatter → routes through schema lint.
 *         No frontmatter → falls through to v1.17.94 regex lint (already covered
 *         by tests/iron-rule-quality.test.js).
 *
 * This file only covers the SKILL.md path.
 */

// VALID_SKILL_MD example body must avoid IR-037 mixed-language (< 15% English).
// The description is the standard English SKILL.md style; lintSkillMdRule excludes
// it from the mixed-language check.
const VALID_SKILL_MD = `---
name: ir-002-no-commit-secrets
description: |
  Use when about to git commit / push any change. Required for ALL commits because
  accidentally pushing secrets to remote repo causes immediate exposure.
  Triggers on: git commit, git push, git stash.
---

# IR-002: 不要 commit 密碼或敏感檔

## 為什麼存在

2026 年 3 月、不小心把含正式環境密碼的設定檔 commit 到公開倉庫、被自動爬蟲撈走、密碼當天就被人拿去打。從此 0 容忍。

## 該做

- 用 git status 看待 commit 檔案
- 把敏感檔案加進忽略清單
- 用工具自動掃 staged 內容
- 密碼一律存 OwnMind 密鑰庫、不寫設定檔

## 不該做

- 不要 git add . 然後不檢查
- 不要在 commit message 貼密碼
- 不要把含密碼的範例檔也 commit

## 萬一犯了

立刻清掉歷史、輪換所有暴露的 key、改密碼、通知可能受影響的人。`;

// Shared valid body — contains the rule keyword, ≥ 130 Chinese chars, dodges IR-037.
const VALID_BODY = `這條鐵律的應用方式說明：每次準備提交程式碼前先檢查、確認沒有把敏感資訊放進去、再正式提交。應該做的事項包括：使用工具檢查、人工 review、最後確認。必須遵守上述步驟、不要跳過任何一步、避免事後補救。如果不小心違反、立刻補救處理、輪換密碼、通知相關人員。`;

function buildRule(content, tags = ['trigger:commit']) {
  return {
    title: '不要 commit .env 或密碼',
    content,
    tags,
  };
}

describe('v1.18.0 — lintIronRule SKILL.md format detection + dispatch', () => {
  it('valid SKILL.md → format=skill_md + ok=true', () => {
    const r = lintIronRule(buildRule(VALID_SKILL_MD));
    assert.equal(r.format, 'skill_md');
    assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  });

  it('plain text (no frontmatter) → format=legacy_text', () => {
    const r = lintIronRule(buildRule('IR-002: 純文字鐵律。\n\n適用情境：commit 前。\n\n規則：不要 commit .env、必須先檢查、避免暴露密碼到 public repo。'));
    assert.equal(r.format, 'legacy_text');
  });

  it('return shape always contains errors / warnings / format', () => {
    const r = lintIronRule(buildRule(VALID_SKILL_MD));
    assert.ok(Array.isArray(r.errors));
    assert.ok(Array.isArray(r.warnings));
    assert.ok(typeof r.format === 'string');
  });
});

describe('v1.18.0 — S1 YAML parsing (after B1 fix: fall back to legacy instead of rejecting outright)', () => {
  // v1.18.0 review B1: YAML parse failure → fall back to legacy lint + warning.
  // The original "S1 reject" test now verifies "fallback warning appears" + "legacy lint outcome."
  // Call lintSkillMdRule directly (skip dispatch) to validate S1 behavior.

  it('lintSkillMdRule called directly: parseError still rejects + emits S1 error', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      parseError: 'YAML 解析失敗: bad mapping',
      body: 'body 內容、湊夠長度。應該必須做的事項：先檢查、然後處理、最後確認。',
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.startsWith('S1')));
    assert.equal(r.format, 'skill_md');
  });

  it('lintIronRule dispatch (B1): YAML invalid + legacy lint also fails → ok=false + fallback warning', () => {
    const content = `---
name: x
description: : invalid : :
---

太短`;
    const r = lintIronRule(buildRule(content));
    assert.equal(r.format, 'legacy_text', 'falls back to legacy');
    assert.equal(r.ok, false, 'legacy lint content also fails');
    assert.ok(r.warnings.some(w => w.includes('frontmatter marker')),
      `should emit fallback warning, actual warnings: ${JSON.stringify(r.warnings)}`);
  });

  it('lintIronRule dispatch (B1): null frontmatter + legacy passes → ok=true + fallback warning', () => {
    const content = `---

---

IR-X: 範例鐵律的內容說明、適用情境是測試環境、規則必須遵守、做這件事情、字數要寫到 100 個以上、所以要再多寫一些湊長度、確保 lint 不會因為太短而退回。`;
    const r = lintIronRule({
      title: 'IR-X 測試',
      content,
      tags: ['trigger:edit'],
    });
    assert.equal(r.format, 'legacy_text');
    assert.equal(r.ok, true, `legacy should pass, errors: ${JSON.stringify(r.errors)}`);
    assert.ok(r.warnings.some(w => w.includes('frontmatter marker')),
      `should emit fallback warning, actual warnings: ${JSON.stringify(r.warnings)}`);
  });
});

describe('v1.18.0 — S2/S3 name rules', () => {
  it('missing name → reject S2', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: { description: 'Use when committing code with proper handling and care' },
      body: VALID_BODY,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.startsWith('S2 frontmatter is missing the name')));
  });

  it('name contains uppercase → reject S2 (not kebab-case)', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: { name: 'IR-002', description: 'Use when committing code with proper handling and care' },
      body: VALID_BODY,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.startsWith('S2')));
  });

  it('name contains underscore → reject S2', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: { name: 'ir_002_test', description: 'Use when committing code with proper handling and care' },
      body: VALID_BODY,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.startsWith('S2')));
  });

  it('name starts/ends with - → reject S2', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: { name: '-bad-', description: 'Use when committing code with proper handling and care' },
      body: VALID_BODY,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.startsWith('S2')));
  });

  it('name too short (< 3) → reject S3', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: { name: 'ab', description: 'Use when committing code with proper handling and care' },
      body: VALID_BODY,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.startsWith('S3')));
  });

  it('name too long (> 60) → reject S3', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: { name: 'a' + '-rule'.repeat(20), description: 'Use when committing code with proper handling and care' },
      body: VALID_BODY,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.startsWith('S3')));
  });
});

describe('v1.18.0 — S4 description required + length bounds', () => {
  it('missing description → reject S4', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: { name: 'ir-002-test' },
      body: VALID_BODY,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.startsWith('S4 frontmatter is missing the description')));
  });

  it('description < 20 chars → reject S4', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: { name: 'ir-002-test', description: '太短' },
      body: VALID_BODY,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.startsWith('S4 description too short')));
  });

  it('description > 500 chars → reject S4', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: { name: 'ir-002-test', description: 'when ' + 'a'.repeat(600) },
      body: VALID_BODY,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.startsWith('S4 description too long')));
  });
});

describe('v1.18.0 — S5 description must include trigger keyword', () => {
  it('description without a trigger keyword → reject S5', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: {
        name: 'ir-002-test',
        description: 'This is a generic description without any trigger keywords lololololol just text here',
      },
      body: VALID_BODY,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.startsWith('S5')));
  });

  it('description containing "Use when" → passes S5', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: {
        name: 'ir-002-test',
        description: 'Use when about to commit code with secrets/passwords/keys—please review',
      },
      body: VALID_BODY,
    });
    assert.ok(!r.errors.some(e => e.startsWith('S5')), `errors: ${JSON.stringify(r.errors)}`);
  });

  it('description containing 何時 → passes S5', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: {
        name: 'ir-002-test',
        description: '何時觸發：準備 commit 前必須先檢查 .env 是否被加進 staged files',
      },
      body: VALID_BODY,
    });
    assert.ok(!r.errors.some(e => e.startsWith('S5')), `errors: ${JSON.stringify(r.errors)}`);
  });
});

describe('v1.18.0 — S6/S7 body length + rule section', () => {
  it('body too short (< 100 chars) → reject S6', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: {
        name: 'ir-002-test',
        description: 'Use when about to commit code with secrets review carefully each time',
      },
      body: '太短的 body',
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.startsWith('S6')));
  });

  it('body missing rule-section keywords → reject S7', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: {
        name: 'ir-002-test',
        description: 'Use when about to commit code with secrets review carefully each time',
      },
      // Pure narrative; must not contain any of 規則/該做/不該做/禁止/必須/應該/不可/不要
      body: '這條鐵律的歷史背景說明：起因是有一次的事件、當時遇到問題、後來檢討為什麼會發生這個情況、最後得到一個結論寫進來變成鐵律、過程中學到了什麼經驗、整理起來放在這裡作為記錄之用、給未來看到的人參考、避免類似事件再次發生、累積經驗成為團隊智慧。',
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.startsWith('S7')), `errors: ${JSON.stringify(r.errors)}`);
  });

  it('body containing 該做 → passes S7', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: {
        name: 'ir-002-test',
        description: 'Use when about to commit code with secrets review carefully each time',
      },
      body: '這裡是 body 內容、長度要 100 字以上。該做的事項包括：先檢查、然後處理、最後確認。寫一些具體的步驟說明、湊到 100 字以上的長度。',
    });
    assert.ok(!r.errors.some(e => e.startsWith('S7')), `errors: ${JSON.stringify(r.errors)}`);
  });
});

describe('v1.18.0 — S9 description warning (< 50 chars; warn, do not reject)', () => {
  it('description 32 chars → warning, not reject', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: {
        name: 'ir-002-test',
        description: 'Use when about to commit secrets',  // 32 chars
      },
      body: VALID_BODY,
    });
    assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
    assert.ok(r.warnings.some(w => w.startsWith('S9')), `warnings: ${JSON.stringify(r.warnings)}`);
  });

  it('description >= 50 chars → no S9 warning', () => {
    const r = lintSkillMdRule(buildRule('placeholder'), {
      has: true,
      frontmatter: {
        name: 'ir-002-test',
        description: 'Use when about to commit code containing secrets, passwords, env files or API keys, essential check',  // 100+ chars
      },
      body: VALID_BODY,
    });
    assert.equal(r.ok, true);
    assert.ok(!r.warnings.some(w => w.startsWith('S9')), `warnings: ${JSON.stringify(r.warnings)}`);
  });
});

describe('v1.18.0 — full valid SKILL.md exemplar round-trip', () => {
  it('IR-002 exemplar SKILL.md passes lint', () => {
    const r = lintIronRule(buildRule(VALID_SKILL_MD));
    assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
    assert.equal(r.format, 'skill_md');
    // description is 100+ chars; no S9 warning expected.
    assert.ok(!r.warnings.some(w => w.startsWith('S9')));
  });
});
