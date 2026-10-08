/**
 * client/src/pages/Usage/rules-vm.js
 *
 * v1.32.4 — 用量與規矩 › 規矩遵守, as data. From the compliance rows of /api/me/report
 * (one per active iron rule: comply / skip / violate / observed) and the pitfalls
 * sections of /api/me/pitfalls, produce the three tiles and the per-rule bars.
 *
 * The formula is on the card, in words: 遵守 ÷（遵守＋略過＋違反）. `observed` is the
 * system noticing a trigger without the AI reporting, and is not part of the rate — the
 * same choice UsageMine made in v1.17, kept here so the two pages cannot disagree.
 * A rule nobody triggered in the range has no rate (null), not 100%.
 */

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.parseInt(v, 10) || 0);

/** comply ÷ (comply + skip + violate) over all rows; null when nothing was reported. */
export function overallRate(rows) {
  let c = 0; let total = 0;
  for (const r of rows ?? []) {
    c += n(r.comply);
    total += n(r.comply) + n(r.skip) + n(r.violate);
  }
  return total === 0 ? null : c / total;
}

/**
 * One bar per rule, lowest rate first so the eye lands on trouble. Rules with nothing
 * in the range sink to the bottom with `rate: null`.
 */
export function ruleBars(rows) {
  const bars = (rows ?? []).map((r) => {
    const comply = n(r.comply); const skip = n(r.skip); const violate = n(r.violate);
    const total = comply + skip + violate;
    return {
      code: r.rule_code ?? null,
      title: r.title ?? r.rule_code ?? '',
      comply, skip, violate, total,
      observed: n(r.observed),
      rate: total === 0 ? null : comply / total,
      pct: {
        comply: total === 0 ? 0 : Math.round((comply / total) * 100),
        skip: total === 0 ? 0 : Math.round((skip / total) * 100),
        violate: total === 0 ? 0 : Math.round((violate / total) * 100),
      },
    };
  });
  return bars.sort((a, b) => {
    if (a.rate === null && b.rate === null) return String(a.code).localeCompare(String(b.code));
    if (a.rate === null) return 1;
    if (b.rate === null) return -1;
    if (a.rate !== b.rate) return a.rate - b.rate;
    return b.total - a.total;
  });
}

/** How many sessions the AI did not report on, from the pitfalls sections; null when unknown. */
export function unreportedSessions(pitfalls) {
  const c = pitfalls?.sections?.orphan_session?.count;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

/** The three tiles: { id, value, note }. `value` is a string the page prints as is. */
export function rulesTiles({ rows, pitfalls }, t) {
  const rate = overallRate(rows);
  const blocked = (rows ?? []).reduce((s, r) => s + n(r.violate), 0);
  const unreported = unreportedSessions(pitfalls);
  return [
    {
      id: 'rate',
      label: t('usage.rules.tile.rate'),
      value: rate === null ? t('home.no_data') : `${Math.round(rate * 100)}%`,
      note: rate === null ? t('usage.rules.tile.rate.none') : t('usage.rules.tile.rate.formula'),
    },
    {
      id: 'blocked',
      label: t('usage.rules.tile.blocked'),
      value: (rows ?? []).length === 0 ? t('home.no_data') : String(blocked),
      note: t('usage.rules.tile.blocked.note'),
    },
    {
      id: 'unreported',
      label: t('usage.rules.tile.unreported'),
      value: unreported === null ? t('home.no_data') : String(unreported),
      note: unreported === null ? t('usage.rules.tile.unreported.none') : t('usage.rules.tile.unreported.note'),
    },
  ];
}
