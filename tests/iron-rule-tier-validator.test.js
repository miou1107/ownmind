import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateTierRequest, applyTierDefault } from '../src/utils/iron-rule-tier-validator.js';

describe('v1.19 — iron-rule-tier validator', () => {
  // ----------------------------------------------------------------
  // validateTierRequest — server route 用的請求驗證
  // ----------------------------------------------------------------

  describe('validateTierRequest', () => {
    it('沒帶 tier 一律 ok（保持向後相容）', () => {
      assert.deepEqual(
        validateTierRequest({ memoryType: 'iron_rule', tier: undefined }),
        { ok: true }
      );
      assert.deepEqual(
        validateTierRequest({ memoryType: 'project', tier: undefined }),
        { ok: true }
      );
      assert.deepEqual(
        validateTierRequest({ memoryType: 'iron_rule', tier: null }),
        { ok: true }
      );
    });

    it('iron_rule + 合法 tier → ok', () => {
      for (const tier of ['critical', 'default', 'advisory']) {
        const r = validateTierRequest({ memoryType: 'iron_rule', tier });
        assert.equal(r.ok, true, `tier='${tier}' 應該 ok`);
      }
    });

    it('iron_rule + 非法 tier → 400，錯誤訊息列出合法選項', () => {
      const r = validateTierRequest({ memoryType: 'iron_rule', tier: 'Important' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
      assert.match(r.error, /tier/);
      assert.match(r.error, /critical/);
      assert.match(r.error, /default/);
      assert.match(r.error, /advisory/);
    });

    it('非 iron_rule + tier → 400（明確告知 tier 限 iron_rule）', () => {
      const r = validateTierRequest({ memoryType: 'project', tier: 'critical' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
      assert.match(r.error, /iron_rule/);
    });

    it('非 iron_rule + 合法 tier 仍然 400（即使 tier 本身合法）', () => {
      const r = validateTierRequest({ memoryType: 'principle', tier: 'default' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
    });

    it('memoryType 缺失但有 tier → 400（防呆，未指定 type 不該設 tier）', () => {
      const r = validateTierRequest({ memoryType: undefined, tier: 'critical' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
    });
  });

  // ----------------------------------------------------------------
  // applyTierDefault — 寫入時補上預設值
  // ----------------------------------------------------------------

  describe('applyTierDefault', () => {
    it('iron_rule 沒帶 tier → 補 default', () => {
      assert.equal(
        applyTierDefault({ memoryType: 'iron_rule', tier: undefined }),
        'default'
      );
      assert.equal(
        applyTierDefault({ memoryType: 'iron_rule', tier: null }),
        'default'
      );
    });

    it('iron_rule 帶合法 tier → 原值', () => {
      assert.equal(applyTierDefault({ memoryType: 'iron_rule', tier: 'critical' }), 'critical');
      assert.equal(applyTierDefault({ memoryType: 'iron_rule', tier: 'advisory' }), 'advisory');
    });

    it('非 iron_rule → 一律 null（不寫 tier 欄位）', () => {
      assert.equal(applyTierDefault({ memoryType: 'project', tier: undefined }), null);
      assert.equal(applyTierDefault({ memoryType: 'principle', tier: undefined }), null);
      // 即使 caller 傳了 tier（之前 validate 應該擋下、這裡是兜底），也回 null
      assert.equal(applyTierDefault({ memoryType: 'project', tier: 'critical' }), null);
    });

    it('iron_rule 帶非法 tier → 補 default（兜底）', () => {
      // 正常流程不會走到這（validate 會先擋），此測試保證 caller 即使忘記
      // 先 validate、寫進 DB 的也是合法值
      assert.equal(applyTierDefault({ memoryType: 'iron_rule', tier: 'invalid' }), 'default');
    });
  });
});
