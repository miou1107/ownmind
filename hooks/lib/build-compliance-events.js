/**
 * Build compliance events for reply-lint hook
 *
 * Pure function, zero external dependencies (other than node:crypto.randomUUID).
 * Extracted from the reply-lint hook for ease of unit testing.
 *
 * v1.19: details.tier added, for use by the admin dashboard / v1.20 gating logic.
 *   tier is looked up by the caller via the iron_rules cache (getTier(rules, ruleCode)).
 *   cache miss / not found → 'default' fallback (getTierFromRules behavior).
 *
 * v1.20.4: the violation `rule` switched to a neutral event constant (no hard-coded personal iron rule numbers).
 *   - violations.rule is now an event constant (e.g. 'lint_jargon_explanation_required').
 *   - When writing the compliance record, look up the corresponding personal iron rule via
 *     metadata.triggered_by_event in the rules cache.
 *   - When no match is found → rule_code stays empty + the message includes the display name
 *     (dashboard search still works).
 */

import { randomUUID } from 'node:crypto';
import { findUserRuleByEvent, getEventDisplayName } from '../../shared/lint-event-types.js';

const MAX_MESSAGE_LEN = 300;

/**
 * @param {Array<{ rule: string, message?: string }>} violations
 * @param {Array<object>} rules — iron rules cache contents
 * @param {(rules: Array, code: string) => string} getTier — from shared/iron-rule-tier.js
 * @returns {Array<object>} compliance events; schema aligned with src/routes/activity.js batch handler.
 */
export function buildComplianceEvents(violations, rules, getTier) {
  if (!Array.isArray(violations)) return [];
  const ts = new Date().toISOString();
  const lookupTier = (typeof getTier === 'function') ? getTier : (() => 'default');

  return violations.map((v) => {
    // v1.20.4: map event constant → personal iron rule code.
    // Look in the rules cache for a rule whose metadata.triggered_by_event === v.rule; use its
    // code in the compliance record. When not found, leave rule_code empty (dashboard can still
    // search by event display name).
    const userRule = findUserRuleByEvent(rules, v.rule);
    const resolvedRuleCode = userRule ? userRule.code : '';
    const eventDisplayName = getEventDisplayName(v.rule);
    const baseMessage = typeof v.message === 'string' ? v.message.slice(0, MAX_MESSAGE_LEN) : '';
    // When there is no matching personal iron rule, prefix the message with the event display name
    // so the dashboard can still identify the row.
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
        // v1.20.4: keep the original event constant for future search / analytics.
        triggered_by_event: v.rule,
      },
    };
  });
}
