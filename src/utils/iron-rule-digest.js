/**
 * Iron Rule Digest — 鐵律精簡摘要（SessionStart hook 用）
 *
 * v1.19 起按 tier 分組顯示：
 *   - 🔴 Critical：核心硬規則，全部列出，給 AI 載入時最高優先
 *   - 🟡 Default： 預設規則，全部列出
 *   - ⚪ Advisory：純參考提示，只顯示計數，避免稀釋 AI 注意力
 *
 * 對應規格：openspec/changes/v1.19-iron-rule-tier/spec.md 場景 6
 */

import { TIER_EMOJI, TIER_LABEL_ZH, normalizeTier, groupByTier } from '../../shared/iron-rule-tier.js';

function formatRuleLine(rule) {
  const code = rule.code || 'IR-?';
  const triggers = (rule.tags || [])
    .filter((t) => typeof t === 'string' && t.startsWith('trigger:'))
    .map((t) => t.replace('trigger:', ''))
    .join('/');
  return triggers
    ? `${code}: ${rule.title} [觸發: ${triggers}]`
    : `${code}: ${rule.title}`;
}

/**
 * 組裝鐵律分組 digest 給 SessionStart 顯示
 *
 * @param {Array<{ code?: string, title: string, tier?: string, tags?: string[] }>} rules
 * @returns {string} — 分組好的 markdown 字串、空陣列回空字串
 */
export function buildIronRulesDigest(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return '';

  const groups = groupByTier(rules);
  const sections = [];

  if (groups.critical.length > 0) {
    sections.push(
      `### ${TIER_EMOJI.critical} Critical（${groups.critical.length} 條）${TIER_LABEL_ZH.critical}`
    );
    for (const rule of groups.critical) sections.push(formatRuleLine(rule));
    sections.push('');
  }

  if (groups.default.length > 0) {
    sections.push(
      `### ${TIER_EMOJI.default} Default（${groups.default.length} 條）${TIER_LABEL_ZH.default}`
    );
    for (const rule of groups.default) sections.push(formatRuleLine(rule));
    sections.push('');
  }

  if (groups.advisory.length > 0) {
    sections.push(
      `### ${TIER_EMOJI.advisory} Advisory（${groups.advisory.length} 條）${TIER_LABEL_ZH.advisory}`
    );
    sections.push('（這層級規則不顯示細節，需要時用 ownmind_get("iron_rule") 完整列出）');
    sections.push('');
  }

  // 去掉最後一個空行
  return sections.join('\n').trimEnd();
}

/**
 * 統計三 tier 的計數（給 admin dashboard / 健康度監控用）
 */
export function countByTier(rules) {
  const counts = { critical: 0, default: 0, advisory: 0, total: 0 };
  if (!Array.isArray(rules)) return counts;
  for (const rule of rules) {
    const tier = normalizeTier(rule && rule.tier);
    counts[tier]++;
    counts.total++;
  }
  return counts;
}
