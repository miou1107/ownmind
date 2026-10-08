/**
 * client/src/pages/Memory/memory-rules-vm.js
 *
 * v1.32.5 — 記憶 › 規矩, as data. Two groups: the person's iron rules (with tier, code
 * and the `trigger:` tags OwnMind matches on) and the team standards they can read.
 * `rows: null` means that list could not be loaded, which the page shows as 「沒有資料」
 * rather than as an empty group.
 */
const TIERS = new Set(['critical', 'default', 'advisory']);

export function ruleRow(m) {
  const tags = Array.isArray(m.tags) ? m.tags : [];
  return {
    id: m.id,
    code: m.code ?? null,
    title: m.title || `#${m.id}`,
    content: m.content ?? '',
    tier: TIERS.has(m.tier) ? m.tier : null,
    triggers: tags.filter((x) => typeof x === 'string' && x.startsWith('trigger:')).map((x) => x.slice('trigger:'.length)),
    updatedAt: m.updated_at ?? m.created_at ?? null,
  };
}

/** Iron rules: critical first, then default, then advisory; within a tier by code. */
function tierRank(tier) {
  return tier === 'critical' ? 0 : tier === 'default' ? 1 : tier === 'advisory' ? 2 : 3;
}

export function ruleGroups({ iron, standards }, t) {
  const ironRows = Array.isArray(iron)
    ? iron.map(ruleRow).sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || String(a.code ?? '').localeCompare(String(b.code ?? '')))
    : null;
  const stdRows = Array.isArray(standards)
    ? standards.map(ruleRow).sort((a, b) => a.title.localeCompare(b.title))
    : null;
  return [
    {
      id: 'iron',
      title: t('memory.rules.iron.title'),
      subtitle: t('memory.rules.iron.subtitle'),
      empty: t('memory.rules.iron.empty'),
      rows: ironRows,
    },
    {
      id: 'standards',
      title: t('memory.rules.standards.title'),
      subtitle: t('memory.rules.standards.subtitle'),
      empty: t('memory.rules.standards.empty'),
      rows: stdRows,
    },
  ];
}
