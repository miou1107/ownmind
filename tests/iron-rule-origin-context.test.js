import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateOriginContext,
  renderOriginContextSection,
  injectOriginSection,
  captureClientOriginContext,
} from '../src/utils/iron-rule-origin-context.js';

describe('v1.18.2 — validateOriginContext', () => {
  it('null/undefined → ok (沒帶不算錯、warning 由 lint 處理)', () => {
    assert.deepEqual(validateOriginContext(null), { ok: true, errors: [] });
    assert.deepEqual(validateOriginContext(undefined), { ok: true, errors: [] });
  });

  it('non-object → reject', () => {
    assert.equal(validateOriginContext('string').ok, false);
    assert.equal(validateOriginContext([1, 2]).ok, false);
    assert.equal(validateOriginContext(123).ok, false);
  });

  it('缺 captured_at / confidence → reject', () => {
    const r = validateOriginContext({});
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('captured_at')));
    assert.ok(r.errors.some(e => e.includes('confidence')));
  });

  it('captured_at 非 ISO → reject', () => {
    const r = validateOriginContext({
      captured_at: 'not-a-date',
      confidence: 'high',
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('ISO 8601')));
  });

  it('confidence 不在 enum → reject', () => {
    const r = validateOriginContext({
      captured_at: new Date().toISOString(),
      confidence: 'bogus',
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('confidence')));
  });

  it('合法最小集合 → ok', () => {
    const r = validateOriginContext({
      captured_at: new Date().toISOString(),
      confidence: 'high',
    });
    assert.equal(r.ok, true);
  });

  it('完整欄位 → ok', () => {
    const r = validateOriginContext({
      captured_at: '2026-05-13T14:30:00+08:00',
      confidence: 'high',
      project: 'OwnMind',
      cwd: '/Users/vin/SourceCode/OwnMind',
      git_branch: 'main',
      event: '升級助手測試發現 IR-037 套錯',
      user_quote: '我覺得鐵律應該記時空背景',
      related_rules: ['IR-037', 'IR-007'],
    });
    assert.equal(r.ok, true);
  });

  it('related_rules 非 string array → reject', () => {
    const r = validateOriginContext({
      captured_at: new Date().toISOString(),
      confidence: 'high',
      related_rules: [1, 2],
    });
    assert.equal(r.ok, false);
  });

  it('event/project 是 number → reject', () => {
    const r = validateOriginContext({
      captured_at: new Date().toISOString(),
      confidence: 'high',
      event: 123,
    });
    assert.equal(r.ok, false);
  });
});

describe('v1.18.2 — renderOriginContextSection', () => {
  it('null → 空字串', () => {
    assert.equal(renderOriginContextSection(null), '');
  });

  it('合法輸入 → markdown 段落含時間 / 信心 / 事件 / quote', () => {
    const md = renderOriginContextSection({
      captured_at: '2026-05-13T14:30:00+08:00',
      confidence: 'high',
      project: 'OwnMind v1.18.2',
      cwd: '/Users/vin/Code',
      git_branch: 'feat/origin',
      event: '測試發現 IR-037 套錯場景',
      user_quote: '我覺得鐵律應該記時空背景',
      related_rules: ['IR-037'],
    });
    assert.match(md, /^## 起源/);
    assert.match(md, /時間.*2026-05-13/);
    assert.match(md, /信心.*high/);
    assert.match(md, /OwnMind v1\.18\.2/);
    assert.match(md, /Git 分支.*feat\/origin/);
    assert.match(md, /測試發現 IR-037/);
    assert.match(md, /> 我覺得鐵律/);
    assert.match(md, /相關鐵律.*IR-037/);
  });

  it('user_direct confidence 顯示說明', () => {
    const md = renderOriginContextSection({
      captured_at: '2026-05-13T14:30:00+08:00',
      confidence: 'user_direct',
    });
    assert.match(md, /user 直接下令建立/);
  });
});

describe('v1.18.2 — injectOriginSection', () => {
  const oc = {
    captured_at: '2026-05-13T14:30:00+08:00',
    confidence: 'high',
    event: 'test event',
  };

  it('content 沒「## 起源」→ append 到末尾', () => {
    const result = injectOriginSection('# 標題\n\n內容...', oc);
    assert.match(result, /^# 標題/);
    assert.match(result, /## 起源/);
    assert.match(result, /test event/);
  });

  it('content 已有「## 起源」block → 替換', () => {
    const old = `# 標題\n\n內容...\n\n## 起源（自動 render from metadata.origin_context）\n\n- **時間**：2026-01-01 00:00:00 UTC\n- **信心**：unknown\n\n`;
    const result = injectOriginSection(old, oc);
    assert.match(result, /test event/);
    // 新 content 不該還有「2026-01-01」舊時間
    assert.ok(!result.includes('2026-01-01'),
      `舊起源段落應被替換、實際: ${result}`);
  });

  it('「## 起源」後接其他 ## 段落 → 只替換起源、保留後面', () => {
    const old = `# 標題

## 起源（自動 render）

- 舊時間

## 該做

- 不要被替換
`;
    const result = injectOriginSection(old, oc);
    assert.match(result, /test event/);
    assert.match(result, /## 該做/);
    assert.match(result, /不要被替換/);
  });

  it('null oc → content 原樣回', () => {
    const r = injectOriginSection('# 內容', null);
    assert.equal(r, '# 內容');
  });
});

describe('v1.18.3 — lintIronRule 必須收到 metadata 才能 check origin_context', () => {
  // 對應 v1.18.3 修的 bug：POST/PUT/admin handler 之前忘了把 metadata 餵進 lint
  // 結果 IR-040 metadata 明明有 origin_context 卻被 warning 誤報「沒帶」
  // import 真 lintIronRule 驗 round-trip
  it('rule.metadata.origin_context 有 → lint 不該 warning「沒帶」', async () => {
    const { lintIronRule } = await import('../src/utils/iron-rule-quality.js');
    const r = lintIronRule({
      title: '測試',
      content: '## 適用情境\n寫鐵律時\n## 規則\n必須遵守。'.repeat(5),
      tags: ['trigger:edit'],
      metadata: {
        origin_context: {
          captured_at: new Date().toISOString(),
          confidence: 'high',
          event: 'test event',
        },
      },
    });
    const ocWarning = (r.warnings || []).find(w =>
      w.includes('建議補 metadata.origin_context')
    );
    assert.equal(ocWarning, undefined,
      `metadata 有 origin_context 不該 warning、實際 warnings: ${JSON.stringify(r.warnings)}`);
  });

  it('rule 沒帶 metadata → lint 該 warning', async () => {
    const { lintIronRule } = await import('../src/utils/iron-rule-quality.js');
    const r = lintIronRule({
      title: '測試',
      content: '## 適用情境\n寫鐵律時\n## 規則\n必須遵守。'.repeat(5),
      tags: ['trigger:edit'],
    });
    const ocWarning = (r.warnings || []).find(w =>
      w.includes('建議補 metadata.origin_context')
    );
    assert.ok(ocWarning, `沒 metadata 該 warning、實際 warnings: ${JSON.stringify(r.warnings)}`);
  });

  it('rule.metadata 不含 origin_context → 該 warning', async () => {
    const { lintIronRule } = await import('../src/utils/iron-rule-quality.js');
    const r = lintIronRule({
      title: '測試',
      content: '## 適用情境\n寫鐵律時\n## 規則\n必須遵守。'.repeat(5),
      tags: ['trigger:edit'],
      metadata: { tool: 'claude-code' },  // 有 metadata 但沒 origin_context
    });
    const ocWarning = (r.warnings || []).find(w =>
      w.includes('建議補 metadata.origin_context')
    );
    assert.ok(ocWarning, '只 tool 沒 origin_context 該 warning');
  });
});

describe('v1.18.2 — captureClientOriginContext', () => {
  it('預設 confidence=unknown + captured_at + cwd', () => {
    const oc = captureClientOriginContext();
    assert.equal(oc.confidence, 'unknown');
    assert.ok(oc.captured_at);
    assert.ok(oc.cwd);  // process.cwd() 一定有
    assert.ok(oc.project);  // 從 cwd basename 推
  });

  it('帶 event / userQuote / confidence 會被保留', () => {
    const oc = captureClientOriginContext({
      event: 'X',
      userQuote: 'Y',
      confidence: 'user_direct',
      relatedRules: ['IR-001'],
    });
    assert.equal(oc.event, 'X');
    assert.equal(oc.user_quote, 'Y');
    assert.equal(oc.confidence, 'user_direct');
    assert.deepEqual(oc.related_rules, ['IR-001']);
  });

  it('生出的 origin_context 能過 validateOriginContext', () => {
    const oc = captureClientOriginContext({
      event: '寫鐵律時自動 capture',
      confidence: 'high',
    });
    const v = validateOriginContext(oc);
    assert.equal(v.ok, true, `errors: ${JSON.stringify(v.errors)}`);
  });
});
