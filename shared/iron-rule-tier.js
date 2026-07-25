/**
 * OwnMind Iron Rule Tier — pure-function module for rule tiering.
 *
 * Corresponds to OpenSpec proposal v1.19-iron-rule-tier.
 *
 * Three tiers:
 *   - critical (hard core rules)    — blocked outright starting v1.20
 *   - default  (default rules)      — warn + record violation
 *   - advisory (informational hint) — record only, no warning from v1.20
 *
 * Zero external deps. Shared by server routes, MCP, hooks, shared/verification.js.
 * Any unknown tier value falls back to default (extension of the "no blind edit" principle:
 * better to conservatively demote to default than silently treat as advisory).
 */

export const VALID_TIERS = ['critical', 'default', 'advisory'];

export const TIER_EMOJI = {
  critical: '🔴',
  default: '🟡',
  advisory: '⚪',
};

// Bilingual tier labels — kept Chinese deliberately for digest rendering.
export const TIER_LABEL_ZH = {
  critical: 'Critical 核心硬規則',
  default: 'Default 預設規則',
  advisory: 'Advisory 純參考提示',
};

export const TIER_ORDER = {
  critical: 0,
  default: 1,
  advisory: 2,
};

const DEFAULT_TIER = 'default';

export function isValidTier(t) {
  return typeof t === 'string' && VALID_TIERS.includes(t);
}

export function normalizeTier(t) {
  return isValidTier(t) ? t : DEFAULT_TIER;
}

export function getTierFromRules(rules, ruleCode) {
  if (!Array.isArray(rules) || !ruleCode || typeof ruleCode !== 'string') {
    return DEFAULT_TIER;
  }
  const rule = rules.find((r) => r && r.code === ruleCode);
  return normalizeTier(rule && rule.tier);
}

export function getTierEmoji(t) {
  return TIER_EMOJI[normalizeTier(t)];
}

export function compareTier(a, b) {
  return TIER_ORDER[normalizeTier(a)] - TIER_ORDER[normalizeTier(b)];
}

export function groupByTier(rules) {
  const groups = { critical: [], default: [], advisory: [] };
  if (!Array.isArray(rules)) return groups;
  for (const rule of rules) {
    const tier = normalizeTier(rule && rule.tier);
    groups[tier].push(rule);
  }
  return groups;
}
