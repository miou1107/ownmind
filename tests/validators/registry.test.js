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
    it('含內建 3 個 validator', () => {
      assert.ok(VALIDATOR_REGISTRY.jargon_explanation);
      assert.ok(VALIDATOR_REGISTRY.language_mixed_ratio);
      assert.ok(VALIDATOR_REGISTRY.privacy_detect);
    });

    it('每個 validator 都有 name + check function', () => {
      for (const [key, mod] of Object.entries(VALIDATOR_REGISTRY)) {
        assert.equal(mod.name, key, `${key} module 的 name 屬性該等於 registry key`);
        assert.equal(typeof mod.check, 'function', `${key} 該有 check function`);
      }
    });
  });

  describe('findValidator', () => {
    it('找到 → 回 module', () => {
      const v = findValidator('jargon_explanation');
      assert.ok(v);
      assert.equal(v.name, 'jargon_explanation');
    });

    it('找不到 → 回 null', () => {
      assert.equal(findValidator('nonexistent'), null);
    });

    it('空字串 → 回 null', () => {
      assert.equal(findValidator(''), null);
    });

    it('null / undefined → 回 null 不 crash', () => {
      assert.equal(findValidator(null), null);
      assert.equal(findValidator(undefined), null);
    });
  });

  describe('listAvailableValidators', () => {
    it('列出 3 個內建 validator name', () => {
      const list = listAvailableValidators();
      assert.ok(list.includes('jargon_explanation'));
      assert.ok(list.includes('language_mixed_ratio'));
      assert.ok(list.includes('privacy_detect'));
      assert.equal(list.length, 3);
    });
  });

  describe('extractEnabledValidators', () => {
    it('規則含 lint_validator → 抽出', () => {
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

    it('規則沒設 lint_validator → 跳過', () => {
      const rules = [
        { code: 'IR-001', metadata: { /* 沒 lint_validator */ } },
        { code: 'IR-002', metadata: null },
        { code: 'IR-003' /* 沒 metadata */ },
      ];
      const enabled = extractEnabledValidators(rules);
      assert.equal(enabled.length, 0);
    });

    it('規則 lint_validator.name 非字串 → 跳過', () => {
      const rules = [
        { code: 'IR-X', metadata: { lint_validator: { name: 123 } } },
        { code: 'IR-Y', metadata: { lint_validator: { name: '' } } },
        { code: 'IR-Z', metadata: { lint_validator: 'not-an-object' } },
      ];
      const enabled = extractEnabledValidators(rules);
      assert.equal(enabled.length, 0);
    });

    it('rules 為非陣列 → 回空陣列不 crash', () => {
      assert.deepEqual(extractEnabledValidators(null), []);
      assert.deepEqual(extractEnabledValidators(undefined), []);
      assert.deepEqual(extractEnabledValidators('not-array'), []);
    });

    it('params 為 undefined → 預設空物件', () => {
      const rules = [
        { code: 'IR-X', metadata: { lint_validator: { name: 'jargon_explanation' /* 沒 params */ } } },
      ];
      const enabled = extractEnabledValidators(rules);
      assert.deepEqual(enabled[0].params, {});
    });
  });

  describe('validator.check 介面合約', () => {
    it('jargon_explanation 通過 → ok=true', () => {
      const v = findValidator('jargon_explanation');
      const result = v.check('好的、了解。', {}, {});
      assert.equal(result.ok, true);
    });

    it('jargon_explanation 違反 → ok=false + violation 物件', () => {
      const v = findValidator('jargon_explanation');
      const result = v.check('我們要 refactor 這個 hook 不然會壞掉。', {}, {});
      assert.equal(result.ok, false);
      assert.ok(result.violation);
      assert.equal(result.violation.event, 'lint_jargon_explanation_required');
      assert.ok(result.violation.message);
    });

    it('language_mixed_ratio 用 user params 的 threshold', () => {
      const v = findValidator('language_mixed_ratio');
      // 低 threshold → 比較容易違反
      const result = v.check('我們 think 該 refactor。', { threshold: 0.05 }, {});
      assert.equal(result.ok, false);
      assert.ok(result.violation.message.includes('5%') || result.violation.message.includes('15%'));
    });

    it('privacy_detect 沒 context.userPrompts → 仍能跑', () => {
      const v = findValidator('privacy_detect');
      const result = v.check('沒個資的句子', {}, {});
      // 沒違反 → ok=true
      assert.equal(result.ok, true);
    });
  });
});
