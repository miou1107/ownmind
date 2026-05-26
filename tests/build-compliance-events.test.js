import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildComplianceEvents } from '../hooks/lib/build-compliance-events.js';
import { getTierFromRules } from '../shared/iron-rule-tier.js';

describe('v1.19 — buildComplianceEvents (reply-lint)', () => {
  // v1.20.4: violations rule uses neutral event constants instead of hard-coded personal iron-rule codes.
  const violations = [
    { rule: 'lint_language_mixed_ratio', message: '中英混雜比例 30%' },
    { rule: 'lint_jargon_explanation_required', message: '行話沒附白話' },
  ];

  // Rule cache contains the matching personal iron rules (linked via triggered_by_event).
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

  it('returns one event per violation', () => {
    const events = buildComplianceEvents(violations, userRules, getTierFromRules);
    assert.equal(events.length, 2);
  });

  it('every event carries the pre-v1.19 required fields + maps to its personal iron-rule code', () => {
    const [first] = buildComplianceEvents(violations, userRules, getTierFromRules);
    assert.ok(first.ts);
    assert.equal(first.event, 'iron_rule_compliance');
    assert.equal(first.tool, 'claude-code');
    assert.equal(first.source, 'reply-lint-hook');
    assert.ok(first.client_event_id);
    assert.equal(first.details.action, 'violate');
    // v1.20.4: maps to the personal iron-rule code via the rule cache.
    assert.equal(first.details.rule_code, 'IR-037');
    // v1.20.4: keep the original event constant.
    assert.equal(first.details.triggered_by_event, 'lint_language_mixed_ratio');
  });

  it('v1.19: details contains the tier field', () => {
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

  it('v1.20.4: cache miss (no personal iron-rule matches the event) → empty rule_code + message prefixed with event name', () => {
    const events = buildComplianceEvents(violations, [], getTierFromRules);
    // No matching rule → rule_code stays empty.
    assert.equal(events[0].details.rule_code, '');
    assert.equal(events[1].details.rule_code, '');
    // tier falls back to default
    assert.equal(events[0].details.tier, 'default');
    // Prefix the message with the event name so the dashboard can still identify it.
    assert.ok(events[0].details.message.startsWith('[Mixed Chinese-English]'),
      `message should begin with the event name: ${events[0].details.message}`);
    assert.ok(events[1].details.message.startsWith('[Jargon quality]'),
      `message should begin with the event name: ${events[1].details.message}`);
    // triggered_by_event still carries the original event constant.
    assert.equal(events[0].details.triggered_by_event, 'lint_language_mixed_ratio');
  });

  it('v1.19: null / undefined rules do not throw; tier falls back to default', () => {
    const a = buildComplianceEvents(violations, null, getTierFromRules);
    const b = buildComplianceEvents(violations, undefined, getTierFromRules);
    assert.equal(a[0].details.tier, 'default');
    assert.equal(b[0].details.tier, 'default');
    // rule_code empty (no rule to match)
    assert.equal(a[0].details.rule_code, '');
    assert.equal(b[0].details.rule_code, '');
  });

  it('v1.19: when getTier is not a function, tier defaults to default and does not throw', () => {
    const events = buildComplianceEvents(violations, [], null);
    assert.equal(events[0].details.tier, 'default');
  });

  it('message is truncated to 300 chars', () => {
    const long = 'x'.repeat(500);
    const events = buildComplianceEvents(
      [{ rule: 'lint_jargon_explanation_required', message: long }],
      userRules,
      getTierFromRules
    );
    // With a matching rule → no prefix, message truncated to 300 as-is.
    assert.equal(events[0].details.message.length, 300);
  });

  it('non-array violations returns an empty array', () => {
    assert.deepEqual(buildComplianceEvents(null, [], getTierFromRules), []);
    assert.deepEqual(buildComplianceEvents(undefined, [], getTierFromRules), []);
    assert.deepEqual(buildComplianceEvents('not-array', [], getTierFromRules), []);
  });

  it('client_event_id is unique across events', () => {
    const events = buildComplianceEvents(violations, userRules, getTierFromRules);
    assert.notEqual(events[0].client_event_id, events[1].client_event_id);
  });
});
