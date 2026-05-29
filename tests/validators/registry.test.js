import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VALIDATOR_REGISTRY,
  findValidator,
  listAvailableValidators,
  extractEnabledValidators,
} from '../../shared/validators/index.js';

describe('v1.21.0 validator registry', () => {

  describe('VALIDATOR_REGISTRY', () => {
    it('includes the 3 built-in validators', () => {
      assert.ok(VALIDATOR_REGISTRY.jargon_explanation);
      assert.ok(VALIDATOR_REGISTRY.language_mixed_ratio);
      assert.ok(VALIDATOR_REGISTRY.privacy_detect);
    });

    it('every validator has a name + check function', () => {
      for (const [key, mod] of Object.entries(VALIDATOR_REGISTRY)) {
        assert.equal(mod.name, key, `${key} module 的 name 屬性該等於 registry key`);
        assert.equal(typeof mod.check, 'function', `${key} 該有 check function`);
      }
    });
  });

  describe('findValidator', () => {
    it('found → returns module', () => {
      const v = findValidator('jargon_explanation');
      assert.ok(v);
      assert.equal(v.name, 'jargon_explanation');
    });

    it('not found → returns null', () => {
      assert.equal(findValidator('nonexistent'), null);
    });

    it('empty string → returns null', () => {
      assert.equal(findValidator(''), null);
    });

    it('null / undefined → returns null without crashing', () => {
      assert.equal(findValidator(null), null);
      assert.equal(findValidator(undefined), null);
    });
  });

  describe('listAvailableValidators', () => {
    it('lists the 3 built-in validator names', () => {
      const list = listAvailableValidators();
      assert.ok(list.includes('jargon_explanation'));
      assert.ok(list.includes('language_mixed_ratio'));
      assert.ok(list.includes('privacy_detect'));
      assert.equal(list.length, 3);
    });
  });

  describe('extractEnabledValidators', () => {
    it('rule with lint_validator → extracted', () => {
      const rules = [
        { code: 'IR-036', metadata: { lint_validator: { name: 'jargon_explanation', params: {} } } },
        { code: 'IR-037', metadata: { lint_validator: { name: 'language_mixed_ratio', params: { threshold: 0.2 } } } },
      ];
      const enabled = extractEnabledValidators(rules);
      assert.equal(enabled.length, 2);
      assert.equal(enabled[0].rule, 'IR-036');
      assert.equal(enabled[0].validator, 'jargon_explanation');
      assert.deepEqual(enabled[1].params, { threshold: 0.2 });
    });

    it('rule without lint_validator → skipped', () => {
      const rules = [
        { code: 'IR-001', metadata: { /* no lint_validator */ } },
        { code: 'IR-002', metadata: null },
        { code: 'IR-003' /* no metadata */ },
      ];
      const enabled = extractEnabledValidators(rules);
      assert.equal(enabled.length, 0);
    });

    it('rule with non-string lint_validator.name → skipped', () => {
      const rules = [
        { code: 'IR-X', metadata: { lint_validator: { name: 123 } } },
        { code: 'IR-Y', metadata: { lint_validator: { name: '' } } },
        { code: 'IR-Z', metadata: { lint_validator: 'not-an-object' } },
      ];
      const enabled = extractEnabledValidators(rules);
      assert.equal(enabled.length, 0);
    });

    it('rules is not an array → returns empty array without crashing', () => {
      assert.deepEqual(extractEnabledValidators(null), []);
      assert.deepEqual(extractEnabledValidators(undefined), []);
      assert.deepEqual(extractEnabledValidators('not-array'), []);
    });

    it('params is undefined → defaults to empty object', () => {
      const rules = [
        { code: 'IR-X', metadata: { lint_validator: { name: 'jargon_explanation' /* no params */ } } },
      ];
      const enabled = extractEnabledValidators(rules);
      assert.deepEqual(enabled[0].params, {});
    });
  });

  describe('validator.check interface contract', () => {
    it('jargon_explanation passes → ok=true', () => {
      const v = findValidator('jargon_explanation');
      const result = v.check('好的、了解。', {}, {});
      assert.equal(result.ok, true);
    });

    it('jargon_explanation violated → ok=false + violation object', () => {
      const v = findValidator('jargon_explanation');
      const result = v.check('我們要 refactor 這個 hook 不然會壞掉。', {}, {});
      assert.equal(result.ok, false);
      assert.ok(result.violation);
      assert.equal(result.violation.event, 'lint_jargon_explanation_required');
      assert.ok(result.violation.message);
    });

    it('language_mixed_ratio uses the threshold from user params', () => {
      const v = findValidator('language_mixed_ratio');
      // Lower threshold → easier to violate
      const result = v.check('我們 think 該 refactor。', { threshold: 0.05 }, {});
      assert.equal(result.ok, false);
      assert.ok(result.violation.message.includes('5%') || result.violation.message.includes('15%'));
    });

    it('privacy_detect without context.userPrompts → still runs', () => {
      const v = findValidator('privacy_detect');
      const result = v.check('沒個資的句子', {}, {});
      // No violation → ok=true
      assert.equal(result.ok, true);
    });
  });
});
