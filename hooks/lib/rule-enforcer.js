/**
 * OwnMind Rule Enforcer — v1.19.6
 *
 * Shared decision core. Given rule_code + context + rules, returns the enforcement decision.
 * Used by three hooks (git pre-commit / PreToolUse / reply-lint).
 *
 * Design principles:
 *   1. Pure function (accepts rules; does not read cache itself — test-friendly).
 *   2. Fail-open (any error → action='allow'; never blocks the workflow).
 *   3. No side effects (no logging, no exit) — those are the hook layer's responsibility.
 *   4. Integrates the tier signal (v1.19) and verification.block_on_fail (pre-v1.18) both.
 *
 * Decision logic for action:
 *   - Rule not in cache                                  → allow + reason='rule_not_in_cache'
 *   - rules not an array                                 → allow + reason='invalid_rules'
 *   - bypass set hit (incl. 'all')                       → bypass
 *   - rule has no verification.conditions                → allow + reason='no_conditions'
 *   - conditions evaluate as pass                        → allow
 *   - conditions violated + tier='critical'              → block
 *   - conditions violated + tier='default' + block_on_fail=true  → block (backward compat)
 *   - conditions violated + tier='default' + block_on_fail=false → warn
 *   - conditions violated + tier='advisory'              → log_only
 */

import { evaluateConditions } from '../../shared/verification.js';
import { normalizeTier } from '../../shared/iron-rule-tier.js';
import { isBypassed } from './bypass-handler.js';

/**
 * Evaluate a single iron rule.
 * @param {string} ruleCode - e.g. 'IR-XXX'
 * @param {object} context - environment data passed to verification handlers
 * @param {object} options
 * @param {Array} options.rules - iron rule array read from the cache
 * @param {Set<string>} [options.bypassSet] - bypass channel; if absent, treated as no bypass
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

  // Bypass takes priority over evaluation (explicit user intent).
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

  // Violation! Decide on action.
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
 * Batch-evaluate multiple iron rules.
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
 * critical always blocks (the core promise of v1.19's tiering).
 * default falls back to block_on_fail (backward compatible with pre-v1.18 configs).
 * advisory only logs (does not interrupt the user).
 */
function decideAction(tier, blockOnFail) {
  if (tier === 'critical') return 'block';
  if (tier === 'advisory') return 'log_only';
  // default
  return blockOnFail ? 'block' : 'warn';
}
