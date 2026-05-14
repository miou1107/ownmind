/**
 * Build compliance events for reply-lint hook
 *
 * 純函式、零外部依賴（除了 node:crypto.randomUUID）。
 * 從 reply-lint hook 抽出來方便單元測試。
 *
 * v1.19: details.tier 加上、給 admin dashboard / v1.20 卡控判斷用。
 *   tier 由 caller 從 iron_rules cache 查好傳進來（getTier(rules, ruleCode)）。
 *   cache miss / 查不到 → 用 'default' 作為 fallback（getTierFromRules 行為）。
 */

import { randomUUID } from 'node:crypto';

const MAX_MESSAGE_LEN = 300;

/**
 * @param {Array<{ rule: string, message?: string }>} violations
 * @param {Array<object>} rules — iron rules cache 內容
 * @param {(rules: Array, code: string) => string} getTier — 從 shared/iron-rule-tier.js 來
 * @returns {Array<object>} compliance events，schema 對齊 src/routes/activity.js batch handler
 */
export function buildComplianceEvents(violations, rules, getTier) {
  if (!Array.isArray(violations)) return [];
  const ts = new Date().toISOString();
  const lookupTier = (typeof getTier === 'function') ? getTier : (() => 'default');
  return violations.map((v) => ({
    ts,
    event: 'iron_rule_compliance',
    tool: 'claude-code',
    source: 'reply-lint-hook',
    client_event_id: randomUUID(),
    details: {
      action: 'violate',
      rule_code: v.rule,
      tier: lookupTier(rules, v.rule),
      message: typeof v.message === 'string' ? v.message.slice(0, MAX_MESSAGE_LEN) : '',
    },
  }));
}
