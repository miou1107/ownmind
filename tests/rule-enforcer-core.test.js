/**
 * Tests for hooks/lib/rule-enforcer.js
 *
 * v1.19.6 — 共用判定核心
 * 純函式 API：給 rule_code + context + rules，回傳判定結果
 *
 * 不擋任何規則 — 這層只計算 action、實際 exit code 由 hook 層決定。
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
  it('規則不在快取 → action=allow + reason=rule_not_in_cache', () => {
    const result = enforceRule('IR-999', {}, { rules: [ruleCritical()] });
    assert.equal(result.action, 'allow');
    assert.equal(result.reason, 'rule_not_in_cache');
    assert.equal(result.rule_code, 'IR-999');
  });

  it('critical 規則違反 → action=block + reason=conditions_violated', () => {
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

  it('critical 規則通過 → action=allow', () => {
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['src/index.js'] },
      { rules: [ruleCritical()] }
    );
    assert.equal(result.action, 'allow');
    assert.equal(result.tier, 'critical');
  });

  it('default 規則違反 → action=warn（block_on_fail=false）', () => {
    const result = enforceRule(
      'IR-008',
      { stagedFiles: ['src/foo.js'] },
      { rules: [ruleDefault()] }
    );
    assert.equal(result.action, 'warn');
    assert.equal(result.tier, 'default');
  });

  it('default 規則違反 + block_on_fail=true → action=block（向後相容）', () => {
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

  it('advisory 規則違反 → action=log_only', () => {
    const result = enforceRule(
      'IR-099',
      { stagedFiles: ['src/foo.js'] },
      { rules: [ruleAdvisory()] }
    );
    assert.equal(result.action, 'log_only');
    assert.equal(result.tier, 'advisory');
  });

  it('規則沒 conditions → action=allow + reason=no_conditions', () => {
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

  it('bypass set 命中 → action=bypass', () => {
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env'] },
      { rules: [ruleCritical()], bypassSet: new Set(['IR-002']) }
    );
    assert.equal(result.action, 'bypass');
    assert.equal(result.rule_code, 'IR-002');
  });

  it('bypass=all 涵蓋任何規則 → action=bypass', () => {
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env'] },
      { rules: [ruleCritical()], bypassSet: new Set(['all']) }
    );
    assert.equal(result.action, 'bypass');
  });

  it('bypass set 沒命中該規則 → 正常判定', () => {
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env'] },
      { rules: [ruleCritical()], bypassSet: new Set(['IR-008']) }
    );
    assert.equal(result.action, 'block');
  });

  it('未提供 bypassSet → 預設無 bypass', () => {
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env'] },
      { rules: [ruleCritical()] }
    );
    assert.equal(result.action, 'block');
  });

  it('context 缺欄位 → 跟 verification handler 的 fallback 一致', () => {
    // staged_files_exclude handler 在 stagedFiles 缺時 return true → pass
    const result = enforceRule('IR-002', {}, { rules: [ruleCritical()] });
    assert.equal(result.action, 'allow');
  });

  it('未知 tier → 視為 default（normalizeTier 行為）', () => {
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

  it('rules 不是陣列 → fail-open + reason=invalid_rules', () => {
    const result = enforceRule('IR-002', {}, { rules: null });
    assert.equal(result.action, 'allow');
    assert.equal(result.reason, 'invalid_rules');
  });

  it('回傳必含 rule_code + rule_title', () => {
    const result = enforceRule(
      'IR-002',
      { stagedFiles: ['.env'] },
      { rules: [ruleCritical()] }
    );
    assert.equal(result.rule_code, 'IR-002');
    assert.equal(result.rule_title, '不要 commit .env');
  });

  it('verification 未知 type → 安全跳過（verification.js 內建 fallback）', () => {
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
    // verification.js 對未知 type 是 return pass=true → enforcer 順 allow
    assert.equal(result.action, 'allow');
    // 沒走 catch path，所以也不會帶 enforcer_internal_error reason
    assert.notEqual(result.reason, 'enforcer_internal_error');
  });

  it('evaluateConditions 真的 throw → fail-open + reason=enforcer_internal_error', () => {
    // 用 getter 真的拋例外、確保 try/catch 被執行（reviewer I-4 修正）
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
// enforceRules — 批次
// ============================================================

describe('enforceRules', () => {
  it('批次評估多條 → 各條獨立判定', () => {
    const results = enforceRules(
      ['IR-002', 'IR-008'],
      { stagedFiles: ['.env'] },
      { rules: [ruleCritical(), ruleDefault()] }
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].action, 'block'); // IR-002 violated
    assert.equal(results[1].action, 'warn');  // IR-008 violated (default tier)
  });

  it('空 ruleCodes → 空陣列', () => {
    const results = enforceRules([], {}, { rules: [ruleCritical()] });
    assert.deepEqual(results, []);
  });
});
