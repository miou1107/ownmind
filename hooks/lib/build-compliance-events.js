/**
 * Build compliance events for reply-lint hook
 *
 * 純函式、零外部依賴（除了 node:crypto.randomUUID）。
 * 從 reply-lint hook 抽出來方便單元測試。
 *
 * v1.19: details.tier 加上、給 admin dashboard / v1.20 卡控判斷用。
 *   tier 由 caller 從 iron_rules cache 查好傳進來（getTier(rules, ruleCode)）。
 *   cache miss / 查不到 → 用 'default' 作為 fallback（getTierFromRules 行為）。
 *
 * v1.20.4：違反清單 rule 改用中性事件常數（避免寫死個人鐵律編號）。
 *   - violations.rule 現在是事件常數（例：'lint_jargon_explanation_required'）
 *   - 寫合規記錄時、從規則快取找 metadata.triggered_by_event 對應的個人鐵律
 *   - 找不到 → rule_code 空 + message 含事件中文名（dashboard 仍能查）
 */

import { randomUUID } from 'node:crypto';
import { findUserRuleByEvent, getEventDisplayName } from '../../shared/lint-event-types.js';

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

  return violations.map((v) => {
    // v1.20.4：事件常數 → 個人鐵律編號對應
    // 規則快取內找 metadata.triggered_by_event === v.rule 的鐵律、用其 code 寫合規
    // 找不到 → rule_code 留空（dashboard 仍能用事件中文名查）
    const userRule = findUserRuleByEvent(rules, v.rule);
    const resolvedRuleCode = userRule ? userRule.code : '';
    const eventDisplayName = getEventDisplayName(v.rule);
    const baseMessage = typeof v.message === 'string' ? v.message.slice(0, MAX_MESSAGE_LEN) : '';
    // 沒有對應個人鐵律時、訊息前綴加事件中文名讓 dashboard 仍能辨識
    const message = resolvedRuleCode ? baseMessage : `[${eventDisplayName}] ${baseMessage}`;

    return {
      ts,
      event: 'iron_rule_compliance',
      tool: 'claude-code',
      source: 'reply-lint-hook',
      client_event_id: randomUUID(),
      details: {
        action: 'violate',
        rule_code: resolvedRuleCode,
        tier: resolvedRuleCode ? lookupTier(rules, resolvedRuleCode) : 'default',
        message,
        // v1.20.4：保留原事件常數、給未來查詢 / 分析用
        triggered_by_event: v.rule,
      },
    };
  });
}
