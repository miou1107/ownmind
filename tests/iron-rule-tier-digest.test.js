import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildIronRulesDigest, countByTier } from '../src/utils/iron-rule-digest.js';

describe('v1.19 — buildIronRulesDigest', () => {
  const mkRule = (code, title, tier, tags) => ({ code, title, tier, tags: tags || [] });

  it('empty array returns empty string', () => {
    assert.equal(buildIronRulesDigest([]), '');
    assert.equal(buildIronRulesDigest(null), '');
    assert.equal(buildIronRulesDigest(undefined), '');
  });

  it('when all rules share a tier, only that section appears, no empty sections', () => {
    const rules = [
      mkRule('IR-002', '不要 commit .env', 'critical', ['trigger:commit']),
      mkRule('IR-005', '不要 blind edit', 'critical', ['trigger:edit']),
    ];
    const out = buildIronRulesDigest(rules);
    assert.match(out, /### 🔴 Critical（2 條）/);
    assert.match(out, /IR-002: 不要 commit \.env \[觸發: commit\]/);
    assert.match(out, /IR-005: 不要 blind edit \[觸發: edit\]/);
    assert.ok(!out.includes('🟡 Default'), 'no Default rules → that section should not appear');
    assert.ok(!out.includes('⚪ Advisory'), 'no Advisory rules → that section should not appear');
  });

  it('all three tiers present → ordered critical → default → advisory', () => {
    const rules = [
      mkRule('IR-013', '刪除按鈕要紅色', 'advisory'),
      mkRule('IR-002', '不要 commit .env', 'critical', ['trigger:commit']),
      mkRule('IR-003', '修 bug 前先寫測試', 'default', ['trigger:edit']),
    ];
    const out = buildIronRulesDigest(rules);
    const criticalIdx = out.indexOf('🔴 Critical');
    const defaultIdx = out.indexOf('🟡 Default');
    const advisoryIdx = out.indexOf('⚪ Advisory');
    assert.ok(criticalIdx >= 0 && defaultIdx >= 0 && advisoryIdx >= 0);
    assert.ok(criticalIdx < defaultIdx, 'Critical must come before Default');
    assert.ok(defaultIdx < advisoryIdx, 'Default must come before Advisory');
  });

  it('Advisory section shows only the count, no per-rule detail (avoids diluting AI attention)', () => {
    const rules = [
      mkRule('IR-002', 'critical-rule', 'critical'),
      mkRule('IR-013', '刪除按鈕要紅色', 'advisory'),
      mkRule('IR-016', 'Windows MCP', 'advisory'),
    ];
    const out = buildIronRulesDigest(rules);
    assert.match(out, /⚪ Advisory（2 條）/);
    // Detail for IR-013 / IR-016 should not appear.
    assert.ok(!out.includes('IR-013'), 'Advisory section must not list rule codes');
    assert.ok(!out.includes('IR-016'), 'Advisory section must not list rule codes');
    // But it should hint how to retrieve the detail.
    assert.match(out, /ownmind_get/);
  });

  it('rules missing the tier field fall under the Default section', () => {
    const rules = [
      mkRule('IR-002', 'no-tier-rule'), // no tier
    ];
    const out = buildIronRulesDigest(rules);
    assert.match(out, /🟡 Default（1 條）/);
    assert.match(out, /IR-002: no-tier-rule/);
  });

  it('rule without a code falls back to IR-?', () => {
    const rules = [
      { title: 'no-code-rule', tier: 'critical', tags: [] },
    ];
    const out = buildIronRulesDigest(rules);
    assert.match(out, /IR-\?: no-code-rule/);
  });

  it('multiple triggers are joined with /', () => {
    const rules = [
      mkRule('IR-002', 't', 'critical', ['trigger:commit', 'trigger:git']),
    ];
    const out = buildIronRulesDigest(rules);
    assert.match(out, /\[觸發: commit\/git\]/);
  });

  it('no triggers → [觸發: ...] block is omitted', () => {
    const rules = [
      mkRule('IR-002', 't', 'critical'),
    ];
    const out = buildIronRulesDigest(rules);
    assert.match(out, /IR-002: t$/m);
    assert.ok(!out.includes('[觸發:'));
  });

  it('each tier section heading is followed by the rule count for that section', () => {
    const rules = [
      mkRule('A', 'a', 'critical'),
      mkRule('B', 'b', 'critical'),
      mkRule('C', 'c', 'critical'),
      mkRule('D', 'd', 'default'),
    ];
    const out = buildIronRulesDigest(rules);
    assert.match(out, /Critical（3 條）/);
    assert.match(out, /Default（1 條）/);
  });
});

describe('v1.19 — countByTier', () => {
  it('returns counts for all three tiers', () => {
    const rules = [
      { code: 'A', tier: 'critical' },
      { code: 'B', tier: 'critical' },
      { code: 'C', tier: 'default' },
      { code: 'D', tier: 'advisory' },
    ];
    assert.deepEqual(countByTier(rules), { critical: 2, default: 1, advisory: 1, total: 4 });
  });

  it('empty array returns three zeros', () => {
    assert.deepEqual(countByTier([]), { critical: 0, default: 0, advisory: 0, total: 0 });
    assert.deepEqual(countByTier(null), { critical: 0, default: 0, advisory: 0, total: 0 });
  });

  it('rules missing the tier field fall under the default count', () => {
    const rules = [{ code: 'A' }, { code: 'B', tier: 'critical' }];
    assert.deepEqual(countByTier(rules), { critical: 1, default: 1, advisory: 0, total: 2 });
  });
});
