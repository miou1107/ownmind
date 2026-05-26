/**
 * Tests for hooks/lib/rule-enforcer.js
 *
 * v1.19.6 — shared decision core
 * Pure-function API: given rule_code + context + rules, returns a decision.
 *
 * Does not block any rule — this layer only computes the action; the actual
 * exit code is decided by the hook layer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enforceRule,
  enforceRules,
} from '../hooks/lib/rule-enforcer.js';

// ============================================================
// Test fixtures
// ============================================================

function ruleCritical(overrides = {}) {
  return {
    code: 'IR-002',
    title: '不要 commit .env',
    tier: 'critical',
    metadata: {
      verification: {
        block_on_fail: true,
        conditions: {
          type: 'staged_files_exclude',
          params: { patterns: ['.env', '.env.*'] },
          message: '偵測到 .env 檔案進入 commit',
        },
      },
    },
    ...overrides,
  };
}

function ruleDefault(overrides = {}) {
  return {
    code: 'IR-008',
    title: '同步文件',
    tier: 'default',
    metadata: {
      verification: {
        block_on_fail: false,
        conditions: {
          type: 'staged_files_include',
          params: { patterns: ['README.md'] },
          message: 'README 沒同步',
        },
      },
    },
    ...overrides,
  };
}

function ruleAdvisory(overrides = {}) {
  return {
    code: 'IR-099',
    title: '小提醒',
    tier: 'advisory',
    metadata: {
      verification: {
        block_on_fail: false,
        conditions: {
          type: 'staged_files_include',
          params: { patterns: ['CHANGELOG.md'] },
        },
      },
    },
    ...overrides,
  };
}

// ============================================================
// enforceRule
// ============================================================

describe('enforceRule', () => {
  it('rule not in cache → action=allow + reason=rule_not_in_cache', () => {
    const result = enforceRule('IR-999', {}, { rules: [ruleCritical()] });
    assert.equal(result.action, 'allow');
    assert.equal(result.reason, 'rule_not_in_cache');
    assert.equal(result.rule_code, 'IR-999');
  });

  it('critical rule violation → action=block + reason=conditions_violated', () => {
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env.production'] },
      { rules: [ruleCritical()] }
    );
    assert.equal(result.action, 'block');
    assert.equal(result.tier, 'critical');
    assert.equal(result.reason, 'conditions_violated');
    assert.ok(result.failures.length > 0);
    assert.match(result.message, /\.env/);
  });

  it('critical rule passes → action=allow', () => {
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['src/index.js'] },
      { rules: [ruleCritical()] }
    );
    assert.equal(result.action, 'allow');
    assert.equal(result.tier, 'critical');
  });

  it('default rule violation → action=warn (block_on_fail=false)', () => {
    const result = enforceRule(
      'IR-008',
      { stagedFiles: ['src/foo.js'] },
      { rules: [ruleDefault()] }
    );
    assert.equal(result.action, 'warn');
    assert.equal(result.tier, 'default');
  });

  it('default rule violation + block_on_fail=true → action=block (backward compat)', () => {
    const blocking = ruleDefault({
      metadata: {
        verification: {
          block_on_fail: true,
          conditions: {
            type: 'staged_files_include',
            params: { patterns: ['README.md'] },
          },
        },
      },
    });
    const result = enforceRule(
      'IR-008',
      { stagedFiles: ['src/foo.js'] },
      { rules: [blocking] }
    );
    assert.equal(result.action, 'block');
  });

  it('advisory rule violation → action=log_only', () => {
    const result = enforceRule(
      'IR-099',
      { stagedFiles: ['src/foo.js'] },
      { rules: [ruleAdvisory()] }
    );
    assert.equal(result.action, 'log_only');
    assert.equal(result.tier, 'advisory');
  });

  it('rule has no conditions → action=allow + reason=no_conditions', () => {
    const ruleNoConditions = {
      code: 'IR-100',
      title: '空規則',
      tier: 'critical',
      metadata: { verification: {} },
    };
    const result = enforceRule('IR-100', {}, { rules: [ruleNoConditions] });
    assert.equal(result.action, 'allow');
    assert.equal(result.reason, 'no_conditions');
  });

  it('bypass set hits → action=bypass', () => {
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env'] },
      { rules: [ruleCritical()], bypassSet: new Set(['IR-002']) }
    );
    assert.equal(result.action, 'bypass');
    assert.equal(result.rule_code, 'IR-002');
  });

  it('bypass=all covers every rule → action=bypass', () => {
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env'] },
      { rules: [ruleCritical()], bypassSet: new Set(['all']) }
    );
    assert.equal(result.action, 'bypass');
  });

  it('bypass set does not match this rule → normal decision', () => {
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env'] },
      { rules: [ruleCritical()], bypassSet: new Set(['IR-008']) }
    );
    assert.equal(result.action, 'block');
  });

  it('no bypassSet provided → defaults to no bypass', () => {
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env'] },
      { rules: [ruleCritical()] }
    );
    assert.equal(result.action, 'block');
  });

  it('context missing fields → matches verification handler fallback', () => {
    // staged_files_exclude handler returns true → pass when stagedFiles is missing
    const result = enforceRule('IR-002', {}, { rules: [ruleCritical()] });
    assert.equal(result.action, 'allow');
  });

  it('unknown tier → treated as default (normalizeTier behavior)', () => {
    const weirdTier = ruleCritical({ tier: 'mystery' });
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env'] },
      { rules: [weirdTier] }
    );
    assert.equal(result.tier, 'default');
    // tier=default + block_on_fail=true → block
    assert.equal(result.action, 'block');
  });

  it('rules is not an array → fail-open + reason=invalid_rules', () => {
    const result = enforceRule('IR-002', {}, { rules: null });
    assert.equal(result.action, 'allow');
    assert.equal(result.reason, 'invalid_rules');
  });

  it('return value must include rule_code + rule_title', () => {
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env'] },
      { rules: [ruleCritical()] }
    );
    assert.equal(result.rule_code, 'IR-002');
    assert.equal(result.rule_title, '不要 commit .env');
  });

  it('unknown verification type → safely skipped (verification.js built-in fallback)', () => {
    const buggyRule = ruleCritical({
      metadata: {
        verification: {
          block_on_fail: true,
          conditions: { type: 'definitely_nonexistent_type' },
        },
      },
    });
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env'] },
      { rules: [buggyRule] }
    );
    // verification.js returns pass=true for unknown type → enforcer follows with allow
    assert.equal(result.action, 'allow');
    // The catch path is not taken, so reason should not be enforcer_internal_error
    assert.notEqual(result.reason, 'enforcer_internal_error');
  });

  it('evaluateConditions actually throws → fail-open + reason=enforcer_internal_error', () => {
    // Throw from a getter to make sure try/catch is exercised (reviewer I-4 fix)
    const throwingConditions = {};
    Object.defineProperty(throwingConditions, 'when', {
      get() {
        throw new Error('intentional test error');
      },
      enumerable: true,
    });
    const buggyRule = ruleCritical({
      metadata: {
        verification: {
          block_on_fail: true,
          conditions: throwingConditions,
        },
      },
    });
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env'] },
      { rules: [buggyRule] }
    );
    assert.equal(result.action, 'allow');
    assert.equal(result.reason, 'enforcer_internal_error');
    assert.match(result.error, /intentional test error/);
  });
});

// ============================================================
// enforceRules — batch
// ============================================================

describe('enforceRules', () => {
  it('batch evaluation → each rule decided independently', () => {
    const results = enforceRules(
      ['IR-002', 'IR-008'],
      { stagedFiles: ['.env'] },
      { rules: [ruleCritical(), ruleDefault()] }
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].action, 'block'); // IR-002 violated
    assert.equal(results[1].action, 'warn');  // IR-008 violated (default tier)
  });

  it('empty ruleCodes → empty array', () => {
    const results = enforceRules([], {}, { rules: [ruleCritical()] });
    assert.deepEqual(results, []);
  });
});
