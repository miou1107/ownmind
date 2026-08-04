// v1.26.56 — the compliance blocks: 鐵律合規率, 各規則落地率, 各工具落地率,
// 每條鐵律落地率表, 從未被觸發的規則.
//
// This file is mostly one defect, asserted from several angles.
//
// The legacy 各規則落地率 and 各工具落地率 blocks compute
//
//     const rate = t > 0 ? ((acts.comply||0)/t*100).toFixed(0) : 0;
//     const color = rate >= 90 ? green : rate >= 70 ? amber : red;
//
// so a rule with no events in the period lands on `0`, fails both thresholds,
// and is painted solid red at 0%. "We never observed this rule" is rendered as
// "this rule fails every single time". That is precisely what Requirement 7 of
// the umbrella spec forbids, and it is why the null case gets its own band here
// instead of sharing the numeric path.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  complianceBand,
  rateRows,
  ruleStatsRows,
  neverTriggeredTitles,
} from '../client/src/pages/Team/stats-compliance-vm.js';

describe('complianceBand — the legacy thresholds, plus a band for "never measured"', () => {
  it('90 and above is high', () => {
    assert.equal(complianceBand(100), 'high');
    assert.equal(complianceBand(90), 'high');
  });

  it('70 to 89 is mid', () => {
    assert.equal(complianceBand(89), 'mid');
    assert.equal(complianceBand(70), 'mid');
  });

  it('below 70 is low', () => {
    assert.equal(complianceBand(69), 'low');
    assert.equal(complianceBand(0), 'low');
  });

  it('null is its own band, not low', () => {
    assert.equal(complianceBand(null), 'unmeasured');
    assert.equal(complianceBand(undefined), 'unmeasured');
  });
});

describe('rateRows — used by both 各規則落地率 and 各工具落地率', () => {
  it('computes the rate from comply over the three actions', () => {
    const rows = rateRows({ 'IR-020': { comply: 9, skip: 1, violate: 0 } });
    assert.equal(rows[0].total, 10);
    assert.equal(rows[0].rate, 90);
    assert.equal(rows[0].band, 'high');
  });

  it('treats a missing action key as zero', () => {
    const rows = rateRows({ 'IR-020': { comply: 4 } });
    assert.equal(rows[0].skipped, 0);
    assert.equal(rows[0].violated, 0);
    assert.equal(rows[0].rate, 100);
  });

  it('THE DEFECT: an entry with no events is unmeasured, not a red zero', () => {
    const rows = rateRows({ 'IR-099': { comply: 0, skip: 0, violate: 0 } });
    assert.equal(rows[0].total, 0);
    assert.equal(rows[0].rate, null, 'no events means no rate, not a rate of 0');
    assert.equal(rows[0].band, 'unmeasured', 'must not fall through to the failure colour');
  });

  it('a real zero rate is still red', () => {
    // 0 comply out of 5 violate is a measured, genuine total failure. It has to
    // stay distinguishable from the row above.
    const rows = rateRows({ 'IR-013': { comply: 0, skip: 0, violate: 5 } });
    assert.equal(rows[0].total, 5);
    assert.equal(rows[0].rate, 0);
    assert.equal(rows[0].band, 'low');
  });

  it('orders by total descending so the best-evidenced rows lead', () => {
    const rows = rateRows({
      quiet: { comply: 1, skip: 0, violate: 0 },
      busy: { comply: 40, skip: 5, violate: 5 },
    });
    assert.deepEqual(rows.map((r) => r.key), ['busy', 'quiet']);
  });

  it('an empty or absent map yields no rows', () => {
    assert.deepEqual(rateRows({}), []);
    assert.deepEqual(rateRows(null), []);
  });

  it('a null rule title or tool becomes the translatable "unknown" key', () => {
    // `details->>'rule_title'` and `activity_logs.tool` are nullable; a null
    // survives GROUP BY into an object key as the literal string "null", which
    // the legacy page printed on screen.
    const rows = rateRows({ null: { comply: 2, skip: 0, violate: 0 } });
    assert.equal(rows[0].key, 'unknown');
    assert.equal(rows[0].rate, 100, 'remapping the key must not disturb the numbers');
  });

  it('a rule genuinely titled something else is left alone', () => {
    assert.equal(rateRows({ 'nullify the cache': { comply: 1 } })[0].key, 'nullify the cache');
  });
});

describe('ruleStatsRows — the 每條鐵律落地率 table from GET /stats/rules', () => {
  const rule = (o = {}) => ({
    id: 1, code: 'IR-020', title: '部署後必須瀏覽器實測',
    enforced: 9, skipped: 1, violated: 0, total: 10, compliance_rate: 90,
    metadata: null, ...o,
  });

  it('passes the server-computed rate through and bands it', () => {
    const rows = ruleStatsRows([rule()]);
    assert.equal(rows[0].rate, 90);
    assert.equal(rows[0].band, 'high');
  });

  it('a rule the period never exercised is unmeasured', () => {
    const rows = ruleStatsRows([rule({ enforced: 0, skipped: 0, violated: 0, total: 0, compliance_rate: null })]);
    assert.equal(rows[0].rate, null);
    assert.equal(rows[0].band, 'unmeasured');
    // The counts are real zeros and stay zeros — the table's job is to show
    // that nothing happened, and a dash in those cells would hide it.
    assert.equal(rows[0].enforced, 0);
    assert.equal(rows[0].violated, 0);
  });

  it('falls back to the title when a rule has no code', () => {
    const rows = ruleStatsRows([rule({ code: null })]);
    assert.equal(rows[0].codeLabel, null, 'no code means no code, not the title smuggled into that column');
    assert.equal(rows[0].title, '部署後必須瀏覽器實測');
  });

  it('surfaces the auto-verification triggers when metadata carries them', () => {
    const rows = ruleStatsRows([rule({ metadata: { verification: { trigger: ['deploy', 'command'] } } })]);
    assert.deepEqual(rows[0].verifyTriggers, ['deploy', 'command']);
  });

  it('metadata without verification yields no triggers', () => {
    assert.equal(ruleStatsRows([rule({ metadata: {} })])[0].verifyTriggers, null);
    assert.equal(ruleStatsRows([rule()])[0].verifyTriggers, null);
  });

  it('a verification block with no trigger array does not throw', () => {
    const rows = ruleStatsRows([rule({ metadata: { verification: {} } })]);
    assert.deepEqual(rows[0].verifyTriggers, []);
  });

  it('an absent rule list yields no rows', () => {
    assert.deepEqual(ruleStatsRows(null), []);
    assert.deepEqual(ruleStatsRows([]), []);
  });
});

describe('neverTriggeredTitles — kept as its own statement', () => {
  it('returns the titles the server marked never-tested', () => {
    const out = neverTriggeredTitles({ rules_never_tested: ['A', 'B'] });
    assert.deepEqual(out, ['A', 'B']);
  });

  it('is empty when every rule has data, so the block can be omitted entirely', () => {
    assert.deepEqual(neverTriggeredTitles({ rules_never_tested: [] }), []);
    assert.deepEqual(neverTriggeredTitles({}), []);
    assert.deepEqual(neverTriggeredTitles(null), []);
  });

  it('does not feed the compliance denominator', () => {
    // Requirement 3: with 88 active rules and a handful triggered per week,
    // folding the untriggered ones into the rate manufactures a low score out
    // of an absence of evidence. rateRows only ever sees rules with events, so
    // this asserts the two paths stay separate.
    const rows = rateRows({ busy: { comply: 10, skip: 0, violate: 0 } });
    const never = neverTriggeredTitles({ rules_never_tested: ['quiet-1', 'quiet-2'] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rate, 100, 'two untriggered rules must not drag 100% down');
    assert.equal(never.length, 2);
  });
});
