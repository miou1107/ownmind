/**
 * Iron Rule Digest — concise iron-rule summary (used by the SessionStart hook)
 *
 * Since v1.19, displayed grouped by tier:
 *   - 🔴 Critical: core hard rules, all listed, highest priority when the AI loads them
 *   - 🟡 Default:  default rules, all listed
 *   - ⚪ Advisory: pure reference hints, count only, to avoid diluting the AI's attention
 *
 * Corresponding spec: openspec/changes/v1.19-iron-rule-tier/spec.md scenario 6
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
 * Assemble the grouped iron-rule digest for SessionStart display
 *
 * @param {Array<{ code?: string, title: string, tier?: string, tags?: string[] }>} rules
 * @returns {string} — the grouped markdown string; empty array returns an empty string
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

  // drop the trailing blank line
  return sections.join('\n').trimEnd();
}

/**
 * Count the three tiers (for the admin dashboard / health monitoring)
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
