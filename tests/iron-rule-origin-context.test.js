import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateOriginContext,
  renderOriginContextSection,
  injectOriginSection,
  captureClientOriginContext,
} from '../src/utils/iron-rule-origin-context.js';

describe('v1.18.2 — validateOriginContext', () => {
  it('null/undefined → ok (omitted is not an error; lint emits a warning)', () => {
    assert.deepEqual(validateOriginContext(null), { ok: true, errors: [] });
    assert.deepEqual(validateOriginContext(undefined), { ok: true, errors: [] });
  });

  it('non-object → reject', () => {
    assert.equal(validateOriginContext('string').ok, false);
    assert.equal(validateOriginContext([1, 2]).ok, false);
    assert.equal(validateOriginContext(123).ok, false);
  });

  it('missing captured_at / confidence → reject', () => {
    const r = validateOriginContext({});
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('captured_at')));
    assert.ok(r.errors.some(e => e.includes('confidence')));
  });

  it('captured_at not ISO → reject', () => {
    const r = validateOriginContext({
      captured_at: 'not-a-date',
      confidence: 'high',
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('ISO 8601')));
  });

  it('confidence not in enum → reject', () => {
    const r = validateOriginContext({
      captured_at: new Date().toISOString(),
      confidence: 'bogus',
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('confidence')));
  });

  it('minimal valid set → ok', () => {
    const r = validateOriginContext({
      captured_at: new Date().toISOString(),
      confidence: 'high',
    });
    assert.equal(r.ok, true);
  });

  it('full fields → ok', () => {
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

  it('related_rules not a string array → reject', () => {
    const r = validateOriginContext({
      captured_at: new Date().toISOString(),
      confidence: 'high',
      related_rules: [1, 2],
    });
    assert.equal(r.ok, false);
  });

  it('event/project is a number → reject', () => {
    const r = validateOriginContext({
      captured_at: new Date().toISOString(),
      confidence: 'high',
      event: 123,
    });
    assert.equal(r.ok, false);
  });
});

describe('v1.18.2 — renderOriginContextSection', () => {
  it('null → empty string', () => {
    assert.equal(renderOriginContextSection(null), '');
  });

  it('valid input → markdown section containing time / confidence / event / quote', () => {
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

  it('user_direct confidence shows an explanation', () => {
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

  it('content without "## 起源" → append at the end', () => {
    const result = injectOriginSection('# 標題\n\n內容...', oc);
    assert.match(result, /^# 標題/);
    assert.match(result, /## 起源/);
    assert.match(result, /test event/);
  });

  it('content with an existing "## 起源" block → replace', () => {
    const old = `# 標題\n\n內容...\n\n## 起源（自動 render from metadata.origin_context）\n\n- **時間**：2026-01-01 00:00:00 UTC\n- **信心**：unknown\n\n`;
    const result = injectOriginSection(old, oc);
    assert.match(result, /test event/);
    // The new content must not retain the old "2026-01-01" timestamp.
    assert.ok(!result.includes('2026-01-01'),
      `old origin section should be replaced, actual: ${result}`);
  });

  it('"## 起源" followed by another ## section → replace only origin; keep the rest', () => {
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

  it('null oc → content returned as-is', () => {
    const r = injectOriginSection('# 內容', null);
    assert.equal(r, '# 內容');
  });
});

describe('v1.18.3 — lintIronRule must receive metadata to check origin_context', () => {
  // Tracks the v1.18.3 bug: POST/PUT/admin handlers forgot to feed metadata into lint.
  // Result: IR-040 metadata clearly had origin_context but lint warned "missing."
  // Import the real lintIronRule for round-trip verification.
  it('rule.metadata.origin_context present → lint should not warn "missing"', async () => {
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
      `metadata with origin_context should not warn, actual warnings: ${JSON.stringify(r.warnings)}`);
  });

  it('rule without metadata → lint should warn', async () => {
    const { lintIronRule } = await import('../src/utils/iron-rule-quality.js');
    const r = lintIronRule({
      title: '測試',
      content: '## 適用情境\n寫鐵律時\n## 規則\n必須遵守。'.repeat(5),
      tags: ['trigger:edit'],
    });
    const ocWarning = (r.warnings || []).find(w =>
      w.includes('建議補 metadata.origin_context')
    );
    assert.ok(ocWarning, `no metadata should warn, actual warnings: ${JSON.stringify(r.warnings)}`);
  });

  it('rule.metadata without origin_context → should warn', async () => {
    const { lintIronRule } = await import('../src/utils/iron-rule-quality.js');
    const r = lintIronRule({
      title: '測試',
      content: '## 適用情境\n寫鐵律時\n## 規則\n必須遵守。'.repeat(5),
      tags: ['trigger:edit'],
      metadata: { tool: 'claude-code' },  // metadata present but no origin_context
    });
    const ocWarning = (r.warnings || []).find(w =>
      w.includes('建議補 metadata.origin_context')
    );
    assert.ok(ocWarning, 'tool-only metadata without origin_context should warn');
  });
});

describe('v1.18.2 — captureClientOriginContext', () => {
  it('default confidence=unknown + captured_at + cwd', () => {
    const oc = captureClientOriginContext();
    assert.equal(oc.confidence, 'unknown');
    assert.ok(oc.captured_at);
    assert.ok(oc.cwd);  // process.cwd() always exists
    assert.ok(oc.project);  // derived from cwd basename
  });

  it('event / userQuote / confidence are preserved when passed in', () => {
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

  it('the produced origin_context passes validateOriginContext', () => {
    const oc = captureClientOriginContext({
      event: '寫鐵律時自動 capture',
      confidence: 'high',
    });
    const v = validateOriginContext(oc);
    assert.equal(v.ok, true, `errors: ${JSON.stringify(v.errors)}`);
  });
});
