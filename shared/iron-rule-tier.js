/**
 * OwnMind Iron Rule Tier — 鐵律分級純函式模組
 *
 * 對應 OpenSpec 提案 v1.19-iron-rule-tier。
 *
 * 三級設計：
 *   - critical（核心硬規則）— v1.20 起會被直接卡控
 *   - default  （預設規則）  — 跳警告 + 寫違反紀錄
 *   - advisory（純參考提示）— v1.20 起只寫紀錄、不跳警告
 *
 * 本檔零外部依賴，被 server route、MCP、各 hook、shared/verification.js 共用。
 * 任何不認得的 tier 值都自動 fallback 為 default（IR-005 不要 blind edit 的延伸：
 * 寧可保守降級到 default、也不要把規則當 advisory 默默忽略）。
 */

export const VALID_TIERS = ['critical', 'default', 'advisory'];

export const TIER_EMOJI = {
  critical: '🔴',
  default: '🟡',
  advisory: '⚪',
};

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
