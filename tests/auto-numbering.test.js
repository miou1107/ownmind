import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateNextIronRuleCode } from '../src/utils/auto-numbering.js';

describe('generateNextIronRuleCode', () => {
  it('no existing codes → IR-001', () => {
    assert.equal(generateNextIronRuleCode([]), 'IR-001');
  });

  it('existing IR-013 → IR-014', () => {
    assert.equal(generateNextIronRuleCode(['IR-001', 'IR-013']), 'IR-014');
  });

  it('handles gaps (IR-001, IR-005) → IR-006', () => {
    assert.equal(generateNextIronRuleCode(['IR-001', 'IR-005']), 'IR-006');
  });

  it('handles null/undefined in list', () => {
    assert.equal(generateNextIronRuleCode([null, undefined, 'IR-003']), 'IR-004');
  });

  it('3-digit padding for codes under 100', () => {
    assert.equal(generateNextIronRuleCode(['IR-099']), 'IR-100');
  });
});
