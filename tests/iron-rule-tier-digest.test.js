import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildIronRulesDigest, countByTier } from '../src/utils/iron-rule-digest.js';

describe('v1.19 — buildIronRulesDigest', () => {
  const mkRule = (code, title, tier, tags) => ({ code, title, tier, tags: tags || [] });

  it('空陣列回空字串', () => {
    assert.equal(buildIronRulesDigest([]), '');
    assert.equal(buildIronRulesDigest(null), '');
    assert.equal(buildIronRulesDigest(undefined), '');
  });

  it('全部是同一 tier 時、只列出該段、不顯示其他空段', () => {
    const rules = [
      mkRule('IR-002', '不要 commit .env', 'critical', ['trigger:commit']),
      mkRule('IR-005', '不要 blind edit', 'critical', ['trigger:edit']),
    ];
    const out = buildIronRulesDigest(rules);
    assert.match(out, /### 🔴 Critical（2 條）/);
    assert.match(out, /IR-002: 不要 commit \.env \[觸發: commit\]/);
    assert.match(out, /IR-005: 不要 blind edit \[觸發: edit\]/);
    assert.ok(!out.includes('🟡 Default'), '無 Default 規則時不該出現該段');
    assert.ok(!out.includes('⚪ Advisory'), '無 Advisory 規則時不該出現該段');
  });

  it('三 tier 都有時、依 critical → default → advisory 順序排列', () => {
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
    assert.ok(criticalIdx < defaultIdx, 'Critical 必須在 Default 之前');
    assert.ok(defaultIdx < advisoryIdx, 'Default 必須在 Advisory 之前');
  });

  it('Advisory 段只顯示計數、不列規則細節（避免稀釋 AI 注意力）', () => {
    const rules = [
      mkRule('IR-002', 'critical-rule', 'critical'),
      mkRule('IR-013', '刪除按鈕要紅色', 'advisory'),
      mkRule('IR-016', 'Windows MCP', 'advisory'),
    ];
    const out = buildIronRulesDigest(rules);
    assert.match(out, /⚪ Advisory（2 條）/);
    // 不應該出現 IR-013 / IR-016 的詳細內容
    assert.ok(!out.includes('IR-013'), 'Advisory 段不該列出規則 code');
    assert.ok(!out.includes('IR-016'), 'Advisory 段不該列出規則 code');
    // 但應該提示怎麼取得詳細內容
    assert.match(out, /ownmind_get/);
  });

  it('缺 tier 欄位的規則歸到 Default 段', () => {
    const rules = [
      mkRule('IR-002', 'no-tier-rule'), // 無 tier
    ];
    const out = buildIronRulesDigest(rules);
    assert.match(out, /🟡 Default（1 條）/);
    assert.match(out, /IR-002: no-tier-rule/);
  });

  it('規則沒有 code 用 IR-? 代替', () => {
    const rules = [
      { title: 'no-code-rule', tier: 'critical', tags: [] },
    ];
    const out = buildIronRulesDigest(rules);
    assert.match(out, /IR-\?: no-code-rule/);
  });

  it('多個 trigger 用 / 連接', () => {
    const rules = [
      mkRule('IR-002', 't', 'critical', ['trigger:commit', 'trigger:git']),
    ];
    const out = buildIronRulesDigest(rules);
    assert.match(out, /\[觸發: commit\/git\]/);
  });

  it('沒有 trigger 時不顯示 [觸發: ...] 區塊', () => {
    const rules = [
      mkRule('IR-002', 't', 'critical'),
    ];
    const out = buildIronRulesDigest(rules);
    assert.match(out, /IR-002: t$/m);
    assert.ok(!out.includes('[觸發:'));
  });

  it('每個 tier 段標題後接該段規則計數', () => {
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
  it('回傳三 tier 的計數', () => {
    const rules = [
      { code: 'A', tier: 'critical' },
      { code: 'B', tier: 'critical' },
      { code: 'C', tier: 'default' },
      { code: 'D', tier: 'advisory' },
    ];
    assert.deepEqual(countByTier(rules), { critical: 2, default: 1, advisory: 1, total: 4 });
  });

  it('空陣列回三個 0', () => {
    assert.deepEqual(countByTier([]), { critical: 0, default: 0, advisory: 0, total: 0 });
    assert.deepEqual(countByTier(null), { critical: 0, default: 0, advisory: 0, total: 0 });
  });

  it('缺 tier 欄位的規則歸到 default 計數', () => {
    const rules = [{ code: 'A' }, { code: 'B', tier: 'critical' }];
    assert.deepEqual(countByTier(rules), { critical: 1, default: 1, advisory: 0, total: 2 });
  });
});
