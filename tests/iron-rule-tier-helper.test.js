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
  // 常數
  // ----------------------------------------------------------------

  it('VALID_TIERS 為 [critical, default, advisory]', () => {
    assert.deepEqual(VALID_TIERS, ['critical', 'default', 'advisory']);
  });

  it('TIER_EMOJI 每個 tier 都有 emoji', () => {
    assert.equal(TIER_EMOJI.critical, '🔴');
    assert.equal(TIER_EMOJI.default, '🟡');
    assert.equal(TIER_EMOJI.advisory, '⚪');
  });

  it('TIER_LABEL_ZH 每個 tier 都有中文標籤', () => {
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

  it('isValidTier — 三個合法值都回 true', () => {
    assert.equal(isValidTier('critical'), true);
    assert.equal(isValidTier('default'), true);
    assert.equal(isValidTier('advisory'), true);
  });

  it('isValidTier — 不合法值回 false（含 null / undefined / 空字串 / 數字 / 物件）', () => {
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

  it('normalizeTier — 合法值原樣回傳', () => {
    assert.equal(normalizeTier('critical'), 'critical');
    assert.equal(normalizeTier('default'), 'default');
    assert.equal(normalizeTier('advisory'), 'advisory');
  });

  it('normalizeTier — 任何不合法值（含 null / undefined / 空字串 / 大寫）一律回 default', () => {
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

  it('getTierFromRules — 命中規則回傳該規則的 tier', () => {
    const rules = [
      { code: 'IR-002', tier: 'critical' },
      { code: 'IR-003', tier: 'default' },
    ];
    assert.equal(getTierFromRules(rules, 'IR-002'), 'critical');
    assert.equal(getTierFromRules(rules, 'IR-003'), 'default');
  });

  it('getTierFromRules — 找不到規則回傳 default', () => {
    const rules = [{ code: 'IR-002', tier: 'critical' }];
    assert.equal(getTierFromRules(rules, 'IR-999'), 'default');
  });

  it('getTierFromRules — 規則 tier 欄位缺失回傳 default', () => {
    const rules = [{ code: 'IR-002' }]; // 沒 tier 欄位
    assert.equal(getTierFromRules(rules, 'IR-002'), 'default');
  });

  it('getTierFromRules — 規則 tier 是非法值回傳 default', () => {
    const rules = [{ code: 'IR-002', tier: 'invalid_tier' }];
    assert.equal(getTierFromRules(rules, 'IR-002'), 'default');
  });

  it('getTierFromRules — rules 非陣列回傳 default 不丟錯', () => {
    assert.equal(getTierFromRules(null, 'IR-002'), 'default');
    assert.equal(getTierFromRules(undefined, 'IR-002'), 'default');
    assert.equal(getTierFromRules('not-array', 'IR-002'), 'default');
    assert.equal(getTierFromRules({}, 'IR-002'), 'default');
  });

  it('getTierFromRules — ruleCode 缺失回傳 default 不丟錯', () => {
    const rules = [{ code: 'IR-002', tier: 'critical' }];
    assert.equal(getTierFromRules(rules, null), 'default');
    assert.equal(getTierFromRules(rules, undefined), 'default');
    assert.equal(getTierFromRules(rules, ''), 'default');
  });

  // ----------------------------------------------------------------
  // getTierEmoji
  // ----------------------------------------------------------------

  it('getTierEmoji — 各 tier 對應 emoji', () => {
    assert.equal(getTierEmoji('critical'), '🔴');
    assert.equal(getTierEmoji('default'), '🟡');
    assert.equal(getTierEmoji('advisory'), '⚪');
  });

  it('getTierEmoji — 不合法值用 default 的 emoji', () => {
    assert.equal(getTierEmoji(null), '🟡');
    assert.equal(getTierEmoji('invalid'), '🟡');
  });

  // ----------------------------------------------------------------
  // compareTier — 排序用
  // ----------------------------------------------------------------

  it('compareTier — sort callback：critical 排最前、advisory 排最後', () => {
    const arr = ['advisory', 'default', 'critical'];
    arr.sort(compareTier);
    assert.deepEqual(arr, ['critical', 'default', 'advisory']);
  });

  it('compareTier — 不合法值視為 default 參與排序', () => {
    const arr = ['advisory', 'invalid', 'critical'];
    arr.sort(compareTier);
    assert.deepEqual(arr, ['critical', 'invalid', 'advisory']);
  });

  // ----------------------------------------------------------------
  // groupByTier
  // ----------------------------------------------------------------

  it('groupByTier — 按 tier 分桶', () => {
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

  it('groupByTier — 缺 tier 欄位的規則歸到 default 桶', () => {
    const rules = [
      { code: 'IR-002' },                           // 無 tier
      { code: 'IR-003', tier: 'invalid' },          // 非法 tier
      { code: 'IR-004', tier: 'critical' },         // 正常
    ];
    const groups = groupByTier(rules);
    assert.equal(groups.default.length, 2);
    assert.equal(groups.critical.length, 1);
    assert.equal(groups.advisory.length, 0);
  });

  it('groupByTier — 空陣列、null、undefined 都回三個空桶', () => {
    assert.deepEqual(groupByTier([]), { critical: [], default: [], advisory: [] });
    assert.deepEqual(groupByTier(null), { critical: [], default: [], advisory: [] });
    assert.deepEqual(groupByTier(undefined), { critical: [], default: [], advisory: [] });
  });
});
