import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildComplianceEvents } from '../hooks/lib/build-compliance-events.js';
import { getTierFromRules } from '../shared/iron-rule-tier.js';

describe('v1.19 — buildComplianceEvents (reply-lint)', () => {
  const violations = [
    { rule: 'IR-002', message: '密碼洩漏' },
    { rule: 'IR-037', message: '中英混雜比例 30%' },
  ];

  it('回傳 violations.length 筆 event', () => {
    const events = buildComplianceEvents(violations, [], getTierFromRules);
    assert.equal(events.length, 2);
  });

  it('每筆 event 都有 v1.19 之前的必填欄位', () => {
    const [first] = buildComplianceEvents(violations, [], getTierFromRules);
    assert.ok(first.ts);
    assert.equal(first.event, 'iron_rule_compliance');
    assert.equal(first.tool, 'claude-code');
    assert.equal(first.source, 'reply-lint-hook');
    assert.ok(first.client_event_id);
    assert.equal(first.details.action, 'violate');
    assert.equal(first.details.rule_code, 'IR-002');
  });

  it('v1.19: details 含 tier 欄位', () => {
    const rules = [
      { code: 'IR-002', tier: 'critical' },
      { code: 'IR-037', tier: 'default' },
    ];
    const events = buildComplianceEvents(violations, rules, getTierFromRules);
    assert.equal(events[0].details.tier, 'critical');
    assert.equal(events[1].details.tier, 'default');
  });

  it('v1.19: cache miss（rules 內找不到）tier 用 default', () => {
    const events = buildComplianceEvents(violations, [], getTierFromRules);
    assert.equal(events[0].details.tier, 'default');
    assert.equal(events[1].details.tier, 'default');
  });

  it('v1.19: rules 為 null / undefined 不丟錯、tier 用 default', () => {
    const a = buildComplianceEvents(violations, null, getTierFromRules);
    const b = buildComplianceEvents(violations, undefined, getTierFromRules);
    assert.equal(a[0].details.tier, 'default');
    assert.equal(b[0].details.tier, 'default');
  });

  it('v1.19: getTier 不是 function 時、tier 用 default、不丟錯', () => {
    const events = buildComplianceEvents(violations, [], null);
    assert.equal(events[0].details.tier, 'default');
  });

  it('message 截斷到 300 字以內', () => {
    const long = 'x'.repeat(500);
    const events = buildComplianceEvents([{ rule: 'IR-X', message: long }], [], getTierFromRules);
    assert.equal(events[0].details.message.length, 300);
  });

  it('violations 為非陣列回傳空陣列', () => {
    assert.deepEqual(buildComplianceEvents(null, [], getTierFromRules), []);
    assert.deepEqual(buildComplianceEvents(undefined, [], getTierFromRules), []);
    assert.deepEqual(buildComplianceEvents('not-array', [], getTierFromRules), []);
  });

  it('每筆 event 的 client_event_id 互相唯一', () => {
    const events = buildComplianceEvents(violations, [], getTierFromRules);
    assert.notEqual(events[0].client_event_id, events[1].client_event_id);
  });
});
