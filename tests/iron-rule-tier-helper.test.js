import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  VALID_TIERS,
  TIER_EMOJI,
  TIER_LABEL_ZH,
  TIER_ORDER,
  isValidTier,
  normalizeTier,
  getTierFromRules,
  getTierEmoji,
  compareTier,
  groupByTier,
} from '../shared/iron-rule-tier.js';

describe('v1.19 — iron-rule-tier helper', () => {
  // ----------------------------------------------------------------
  // Constants
  // ----------------------------------------------------------------

  it('VALID_TIERS is [critical, default, advisory]', () => {
    assert.deepEqual(VALID_TIERS, ['critical', 'default', 'advisory']);
  });

  it('TIER_EMOJI has an emoji for every tier', () => {
    assert.equal(TIER_EMOJI.critical, '🔴');
    assert.equal(TIER_EMOJI.default, '🟡');
    assert.equal(TIER_EMOJI.advisory, '⚪');
  });

  it('TIER_LABEL_ZH has a Chinese label for every tier', () => {
    assert.match(TIER_LABEL_ZH.critical, /Critical/);
    assert.match(TIER_LABEL_ZH.default, /Default/);
    assert.match(TIER_LABEL_ZH.advisory, /Advisory/);
  });

  it('TIER_ORDER critical < default < advisory', () => {
    assert.ok(TIER_ORDER.critical < TIER_ORDER.default);
    assert.ok(TIER_ORDER.default < TIER_ORDER.advisory);
  });

  // ----------------------------------------------------------------
  // isValidTier
  // ----------------------------------------------------------------

  it('isValidTier — all three valid values return true', () => {
    assert.equal(isValidTier('critical'), true);
    assert.equal(isValidTier('default'), true);
    assert.equal(isValidTier('advisory'), true);
  });

  it('isValidTier — invalid values return false (incl. null / undefined / empty string / number / object)', () => {
    assert.equal(isValidTier('CRITICAL'), false); // case sensitive
    assert.equal(isValidTier('Important'), false);
    assert.equal(isValidTier(''), false);
    assert.equal(isValidTier(null), false);
    assert.equal(isValidTier(undefined), false);
    assert.equal(isValidTier(0), false);
    assert.equal(isValidTier({}), false);
    assert.equal(isValidTier([]), false);
  });

  // ----------------------------------------------------------------
  // normalizeTier
  // ----------------------------------------------------------------

  it('normalizeTier — valid values returned as-is', () => {
    assert.equal(normalizeTier('critical'), 'critical');
    assert.equal(normalizeTier('default'), 'default');
    assert.equal(normalizeTier('advisory'), 'advisory');
  });

  it('normalizeTier — every invalid value (incl. null / undefined / empty string / uppercase) returns default', () => {
    assert.equal(normalizeTier(null), 'default');
    assert.equal(normalizeTier(undefined), 'default');
    assert.equal(normalizeTier(''), 'default');
    assert.equal(normalizeTier('CRITICAL'), 'default');
    assert.equal(normalizeTier('important'), 'default');
    assert.equal(normalizeTier(123), 'default');
  });

  // ----------------------------------------------------------------
  // getTierFromRules
  // ----------------------------------------------------------------

  it('getTierFromRules — match returns that rule\'s tier', () => {
    const rules = [
      { code: 'IR-002', tier: 'critical' },
      { code: 'IR-003', tier: 'default' },
    ];
    assert.equal(getTierFromRules(rules, 'IR-002'), 'critical');
    assert.equal(getTierFromRules(rules, 'IR-003'), 'default');
  });

  it('getTierFromRules — no match returns default', () => {
    const rules = [{ code: 'IR-002', tier: 'critical' }];
    assert.equal(getTierFromRules(rules, 'IR-999'), 'default');
  });

  it('getTierFromRules — rule with missing tier field returns default', () => {
    const rules = [{ code: 'IR-002' }]; // no tier field
    assert.equal(getTierFromRules(rules, 'IR-002'), 'default');
  });

  it('getTierFromRules — rule with invalid tier returns default', () => {
    const rules = [{ code: 'IR-002', tier: 'invalid_tier' }];
    assert.equal(getTierFromRules(rules, 'IR-002'), 'default');
  });

  it('getTierFromRules — non-array rules returns default, no throw', () => {
    assert.equal(getTierFromRules(null, 'IR-002'), 'default');
    assert.equal(getTierFromRules(undefined, 'IR-002'), 'default');
    assert.equal(getTierFromRules('not-array', 'IR-002'), 'default');
    assert.equal(getTierFromRules({}, 'IR-002'), 'default');
  });

  it('getTierFromRules — missing ruleCode returns default, no throw', () => {
    const rules = [{ code: 'IR-002', tier: 'critical' }];
    assert.equal(getTierFromRules(rules, null), 'default');
    assert.equal(getTierFromRules(rules, undefined), 'default');
    assert.equal(getTierFromRules(rules, ''), 'default');
  });

  // ----------------------------------------------------------------
  // getTierEmoji
  // ----------------------------------------------------------------

  it('getTierEmoji — each tier maps to its emoji', () => {
    assert.equal(getTierEmoji('critical'), '🔴');
    assert.equal(getTierEmoji('default'), '🟡');
    assert.equal(getTierEmoji('advisory'), '⚪');
  });

  it('getTierEmoji — invalid value uses default emoji', () => {
    assert.equal(getTierEmoji(null), '🟡');
    assert.equal(getTierEmoji('invalid'), '🟡');
  });

  // ----------------------------------------------------------------
  // compareTier — for sorting
  // ----------------------------------------------------------------

  it('compareTier — sort callback: critical first, advisory last', () => {
    const arr = ['advisory', 'default', 'critical'];
    arr.sort(compareTier);
    assert.deepEqual(arr, ['critical', 'default', 'advisory']);
  });

  it('compareTier — invalid values participate as default in sorting', () => {
    const arr = ['advisory', 'invalid', 'critical'];
    arr.sort(compareTier);
    assert.deepEqual(arr, ['critical', 'invalid', 'advisory']);
  });

  // ----------------------------------------------------------------
  // groupByTier
  // ----------------------------------------------------------------

  it('groupByTier — buckets by tier', () => {
    const rules = [
      { code: 'IR-002', tier: 'critical' },
      { code: 'IR-003', tier: 'default' },
      { code: 'IR-013', tier: 'advisory' },
      { code: 'IR-005', tier: 'critical' },
    ];
    const groups = groupByTier(rules);
    assert.equal(groups.critical.length, 2);
    assert.equal(groups.default.length, 1);
    assert.equal(groups.advisory.length, 1);
    assert.equal(groups.critical[0].code, 'IR-002');
    assert.equal(groups.critical[1].code, 'IR-005');
  });

  it('groupByTier — rules missing tier fall into the default bucket', () => {
    const rules = [
      { code: 'IR-002' },                           // no tier
      { code: 'IR-003', tier: 'invalid' },          // invalid tier
      { code: 'IR-004', tier: 'critical' },         // normal
    ];
    const groups = groupByTier(rules);
    assert.equal(groups.default.length, 2);
    assert.equal(groups.critical.length, 1);
    assert.equal(groups.advisory.length, 0);
  });

  it('groupByTier — empty array, null, undefined all return three empty buckets', () => {
    assert.deepEqual(groupByTier([]), { critical: [], default: [], advisory: [] });
    assert.deepEqual(groupByTier(null), { critical: [], default: [], advisory: [] });
    assert.deepEqual(groupByTier(undefined), { critical: [], default: [], advisory: [] });
  });
});
