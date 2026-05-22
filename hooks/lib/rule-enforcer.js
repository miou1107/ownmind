/**
 * OwnMind Rule Enforcer — v1.19.6
 *
 * 共用判定核心。給 rule_code + context + rules，回傳判定結果。
 * 三種 hook 共用（git pre-commit / PreToolUse / reply-lint）。
 *
 * 設計原則：
 *   1. 純函式（接收 rules、不自己讀快取；測試友善）
 *   2. fail-open（任何錯誤 → action='allow'、不卡死工作流）
 *   3. 不執行 side effects（不寫 log、不 exit）— 那些是 hook 層的責任
 *   4. 整合 tier（v1.19）與 verification.block_on_fail（v1.18 之前）兩個訊號
 *
 * 決定 action 的邏輯：
 *   - 規則不在快取                                 → allow + reason='rule_not_in_cache'
 *   - rules 非陣列                                 → allow + reason='invalid_rules'
 *   - bypass set 命中（含 'all'）                  → bypass
 *   - 規則沒 verification.conditions               → allow + reason='no_conditions'
 *   - conditions 評估通過                          → allow
 *   - conditions 評估違反 + tier='critical'        → block
 *   - conditions 評估違反 + tier='default'  + block_on_fail=true  → block（向後相容）
 *   - conditions 評估違反 + tier='default'  + block_on_fail=false → warn
 *   - conditions 評估違反 + tier='advisory'        → log_only
 */

import { evaluateConditions } from '../../shared/verification.js';
import { normalizeTier } from '../../shared/iron-rule-tier.js';
import { isBypassed } from './bypass-handler.js';

/**
 * 評估單條鐵律
 * @param {string} ruleCode - 如 'IR-002'
 * @param {object} context - 給 verification handler 的環境資料
 * @param {object} options
 * @param {Array} options.rules - 從快取讀到的鐵律陣列
 * @param {Set<string>} [options.bypassSet] - 放行通道；若未提供則視為無 bypass
 * @returns {object} - { action, rule_code, rule_title?, tier?, failures?, message?, reason? }
 */
export function enforceRule(ruleCode, context, options = {}) {
  const rules = options.rules;
  if (!Array.isArray(rules)) {
    return { action: 'allow', rule_code: ruleCode, reason: 'invalid_rules' };
  }

  const rule = rules.find((r) => r && (r.code === ruleCode || r.metadata?.code === ruleCode));
  if (!rule) {
    return { action: 'allow', rule_code: ruleCode, reason: 'rule_not_in_cache' };
  }

  const tier = normalizeTier(rule.tier);
  const ruleTitle = rule.title || ruleCode;

  // Bypass 優先於評估（user 明示意圖）
  if (isBypassed(ruleCode, options.bypassSet)) {
    return {
      action: 'bypass',
      rule_code: ruleCode,
      rule_title: ruleTitle,
      tier,
    };
  }

  const verification = rule.metadata?.verification;
  if (!verification?.conditions) {
    return {
      action: 'allow',
      rule_code: ruleCode,
      rule_title: ruleTitle,
      tier,
      reason: 'no_conditions',
    };
  }

  let evalResult;
  try {
    evalResult = evaluateConditions(verification.conditions, context || {});
  } catch (err) {
    return {
      action: 'allow',
      rule_code: ruleCode,
      rule_title: ruleTitle,
      tier,
      reason: 'enforcer_internal_error',
      error: err.message,
    };
  }

  if (evalResult.pass) {
    return {
      action: 'allow',
      rule_code: ruleCode,
      rule_title: ruleTitle,
      tier,
    };
  }

  // 違反！決定 action
  const action = decideAction(tier, verification.block_on_fail);

  return {
    action,
    rule_code: ruleCode,
    rule_title: ruleTitle,
    tier,
    reason: 'conditions_violated',
    failures: evalResult.failures || [],
    message: (evalResult.failures || []).join('; '),
  };
}

/**
 * 批次評估多條鐵律
 * @param {string[]} ruleCodes
 * @param {object} context
 * @param {object} options
 * @returns {object[]}
 */
export function enforceRules(ruleCodes, context, options = {}) {
  if (!Array.isArray(ruleCodes)) return [];
  return ruleCodes.map((code) => enforceRule(code, context, options));
}

/**
 * tier + block_on_fail → action
 *
 * critical 一律 block（v1.19 分級的核心承諾）。
 * default 看 block_on_fail（向後相容 v1.18 之前的設定）。
 * advisory 只寫 log（不打擾使用者）。
 */
function decideAction(tier, blockOnFail) {
  if (tier === 'critical') return 'block';
  if (tier === 'advisory') return 'log_only';
  // default
  return blockOnFail ? 'block' : 'warn';
}
