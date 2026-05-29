import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateTierRequest, applyTierDefault } from '../src/utils/iron-rule-tier-validator.js';

describe('v1.19 — iron-rule-tier validator', () => {
  // ----------------------------------------------------------------
  // validateTierRequest — request validation used by the server route
  // ----------------------------------------------------------------

  describe('validateTierRequest', () => {
    it('always ok when tier is absent (stays backward compatible)', () => {
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

    it('iron_rule + valid tier → ok', () => {
      for (const tier of ['critical', 'default', 'advisory']) {
        const r = validateTierRequest({ memoryType: 'iron_rule', tier });
        assert.equal(r.ok, true, `tier='${tier}' 應該 ok`);
      }
    });

    it('iron_rule + invalid tier → 400, error message lists valid options', () => {
      const r = validateTierRequest({ memoryType: 'iron_rule', tier: 'Important' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
      assert.match(r.error, /tier/);
      assert.match(r.error, /critical/);
      assert.match(r.error, /default/);
      assert.match(r.error, /advisory/);
    });

    it('non-iron_rule + tier → 400 (clearly states tier is limited to iron_rule)', () => {
      const r = validateTierRequest({ memoryType: 'project', tier: 'critical' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
      assert.match(r.error, /iron_rule/);
    });

    it('non-iron_rule + valid tier still 400 (even if the tier itself is valid)', () => {
      const r = validateTierRequest({ memoryType: 'principle', tier: 'default' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
    });

    it('memoryType missing but tier present → 400 (guard: should not set tier without a type)', () => {
      const r = validateTierRequest({ memoryType: undefined, tier: 'critical' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
    });
  });

  // ----------------------------------------------------------------
  // applyTierDefault — fill in the default value on write
  // ----------------------------------------------------------------

  describe('applyTierDefault', () => {
    it('iron_rule without tier → fills in default', () => {
      assert.equal(
        applyTierDefault({ memoryType: 'iron_rule', tier: undefined }),
        'default'
      );
      assert.equal(
        applyTierDefault({ memoryType: 'iron_rule', tier: null }),
        'default'
      );
    });

    it('iron_rule with a valid tier → keeps the original value', () => {
      assert.equal(applyTierDefault({ memoryType: 'iron_rule', tier: 'critical' }), 'critical');
      assert.equal(applyTierDefault({ memoryType: 'iron_rule', tier: 'advisory' }), 'advisory');
    });

    it('non-iron_rule → always null (does not write the tier field)', () => {
      assert.equal(applyTierDefault({ memoryType: 'project', tier: undefined }), null);
      assert.equal(applyTierDefault({ memoryType: 'principle', tier: undefined }), null);
      // Even if the caller passes tier (validate should have blocked it; this is a fallback), still return null
      assert.equal(applyTierDefault({ memoryType: 'project', tier: 'critical' }), null);
    });

    it('iron_rule with an invalid tier → fills in default (fallback)', () => {
      // Normal flow never reaches here (validate blocks it first); this test guarantees that
      // even if the caller forgets to validate first, what gets written to the DB is still a valid value
      assert.equal(applyTierDefault({ memoryType: 'iron_rule', tier: 'invalid' }), 'default');
    });
  });
});
