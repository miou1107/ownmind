import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildComplianceEvents } from '../hooks/lib/build-compliance-events.js';
import { getTierFromRules } from '../shared/iron-rule-tier.js';

describe('v1.19 — buildComplianceEvents (reply-lint)', () => {
  // v1.20.4：violations rule 改用中性事件常數、不再寫死個人鐵律編號
  const violations = [
    { rule: 'lint_language_mixed_ratio', message: '中英混雜比例 30%' },
    { rule: 'lint_jargon_explanation_required', message: '行話沒附白話' },
  ];

  // 規則快取裡放對應的個人鐵律（透過 triggered_by_event 對應）
  const userRules = [
    {
      code: 'IR-037',
      title: '回話一律白話中文、不要中英文混雜',
      tier: 'default',
      metadata: { triggered_by_event: 'lint_language_mixed_ratio' },
    },
    {
      code: 'IR-036',
      title: '行話／專有名詞必須附上白話說明',
      tier: 'default',
      metadata: { triggered_by_event: 'lint_jargon_explanation_required' },
    },
  ];

  it('回傳 violations.length 筆 event', () => {
    const events = buildComplianceEvents(violations, userRules, getTierFromRules);
    assert.equal(events.length, 2);
  });

  it('每筆 event 都有 v1.19 之前的必填欄位 + 對應到個人鐵律編號', () => {
    const [first] = buildComplianceEvents(violations, userRules, getTierFromRules);
    assert.ok(first.ts);
    assert.equal(first.event, 'iron_rule_compliance');
    assert.equal(first.tool, 'claude-code');
    assert.equal(first.source, 'reply-lint-hook');
    assert.ok(first.client_event_id);
    assert.equal(first.details.action, 'violate');
    // v1.20.4：透過規則快取對應到個人鐵律編號
    assert.equal(first.details.rule_code, 'IR-037');
    // v1.20.4：保留原事件常數
    assert.equal(first.details.triggered_by_event, 'lint_language_mixed_ratio');
  });

  it('v1.19: details 含 tier 欄位', () => {
    const rulesWithTier = [
      {
        code: 'IR-037', tier: 'critical',
        metadata: { triggered_by_event: 'lint_language_mixed_ratio' },
      },
      {
        code: 'IR-036', tier: 'default',
        metadata: { triggered_by_event: 'lint_jargon_explanation_required' },
      },
    ];
    const events = buildComplianceEvents(violations, rulesWithTier, getTierFromRules);
    assert.equal(events[0].details.tier, 'critical');
    assert.equal(events[1].details.tier, 'default');
  });

  it('v1.20.4: cache miss（沒有對應事件的個人鐵律）→ rule_code 空 + message 加事件中文名前綴', () => {
    const events = buildComplianceEvents(violations, [], getTierFromRules);
    // 沒對應規則 → rule_code 留空
    assert.equal(events[0].details.rule_code, '');
    assert.equal(events[1].details.rule_code, '');
    // tier fallback default
    assert.equal(events[0].details.tier, 'default');
    // message 含事件中文名前綴讓 dashboard 仍能辨識
    assert.ok(events[0].details.message.startsWith('[Mixed Chinese-English]'),
      `message 開頭該含事件名：${events[0].details.message}`);
    assert.ok(events[1].details.message.startsWith('[Jargon quality]'),
      `message 開頭該含事件名：${events[1].details.message}`);
    // triggered_by_event 仍保留原事件常數
    assert.equal(events[0].details.triggered_by_event, 'lint_language_mixed_ratio');
  });

  it('v1.19: rules 為 null / undefined 不丟錯、tier 用 default', () => {
    const a = buildComplianceEvents(violations, null, getTierFromRules);
    const b = buildComplianceEvents(violations, undefined, getTierFromRules);
    assert.equal(a[0].details.tier, 'default');
    assert.equal(b[0].details.tier, 'default');
    // rule_code 空（沒有規則可對應）
    assert.equal(a[0].details.rule_code, '');
    assert.equal(b[0].details.rule_code, '');
  });

  it('v1.19: getTier 不是 function 時、tier 用 default、不丟錯', () => {
    const events = buildComplianceEvents(violations, [], null);
    assert.equal(events[0].details.tier, 'default');
  });

  it('message 截斷到 300 字以內', () => {
    const long = 'x'.repeat(500);
    const events = buildComplianceEvents(
      [{ rule: 'lint_jargon_explanation_required', message: long }],
      userRules,
      getTierFromRules
    );
    // 有對應規則 → message 無前綴、原樣截到 300
    assert.equal(events[0].details.message.length, 300);
  });

  it('violations 為非陣列回傳空陣列', () => {
    assert.deepEqual(buildComplianceEvents(null, [], getTierFromRules), []);
    assert.deepEqual(buildComplianceEvents(undefined, [], getTierFromRules), []);
    assert.deepEqual(buildComplianceEvents('not-array', [], getTierFromRules), []);
  });

  it('每筆 event 的 client_event_id 互相唯一', () => {
    const events = buildComplianceEvents(violations, userRules, getTierFromRules);
    assert.notEqual(events[0].client_event_id, events[1].client_event_id);
  });
});
