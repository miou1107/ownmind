// v1.26.56 — the compliance blocks' view models.
//
// The one rule that matters here: a rate of `null` never joins the numeric
// path. The legacy console wrote
//
//     const rate = total > 0 ? (comply / total * 100) : 0;
//     const color = rate >= 90 ? green : rate >= 70 ? amber : red;
//
// and so painted every never-exercised rule solid red at 0%. An absence of
// evidence was rendered as evidence of failure. `complianceBand(null)` returns
// its own band so that path cannot be taken by accident again.

export const BAND_UNMEASURED = 'unmeasured';

/** Legacy thresholds — 90 and 70 — plus a band for "we never measured this". */
export function complianceBand(rate) {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return BAND_UNMEASURED;
  if (rate >= 90) return 'high';
  if (rate >= 70) return 'mid';
  return 'low';
}

function n(value) {
  const v = Number(value);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Shared by 各規則落地率 and 各工具落地率, which take the same
 * `{ key: { comply, skip, violate } }` shape from `compliance.by_rule` and
 * `compliance.by_tool`.
 *
 * Ordered by total descending so the rows with the most evidence lead. A row
 * with no events at all keeps `rate: null`.
 */
export function rateRows(byKey) {
  if (!byKey || typeof byKey !== 'object') return [];
  return Object.entries(byKey)
    .map(([rawKey, acts]) => {
      // `details->>'rule_title'` and `activity_logs.tool` are both nullable, and
      // a null survives GROUP BY into an object key as the literal string
      // "null". The legacy page printed it; here it takes the dictionary's
      // unknown label like every other unresolvable key.
      const key = rawKey === 'null' ? 'unknown' : rawKey;
      const enforced = n(acts?.comply);
      const skipped = n(acts?.skip);
      const violated = n(acts?.violate);
      const total = enforced + skipped + violated;
      const rate = total > 0 ? Number(((enforced / total) * 100).toFixed(1)) : null;
      return { key, enforced, skipped, violated, total, rate, band: complianceBand(rate) };
    })
    .sort((a, b) => b.total - a.total);
}

/**
 * Rows for the 每條鐵律落地率 table, from `GET /activity/stats/rules`.
 *
 * The server already computes `compliance_rate` (null when the rule saw no
 * events), so this only bands it and unpacks the auto-verification metadata.
 * The enforced / skipped / violated counts stay as literal zeros: the table's
 * job is to show that nothing happened, and dashes there would hide it.
 */
export function ruleStatsRows(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.map((r) => {
    const rate = r.compliance_rate ?? null;
    const verification = r.metadata?.verification;
    return {
      id: r.id ?? null,
      codeLabel: r.code || null,
      title: r.title || '',
      enforced: n(r.enforced),
      skipped: n(r.skipped),
      violated: n(r.violated),
      total: n(r.total),
      rate,
      band: complianceBand(rate),
      verifyTriggers: verification ? (verification.trigger ?? []) : null,
    };
  });
}

/**
 * 從未被觸發的規則, kept as its own statement.
 *
 * Deliberately a separate function from `rateRows`: with 88 active rules and a
 * handful triggered in any given week, folding the untriggered ones into the
 * denominator would manufacture a low score out of an absence of evidence.
 */
export function neverTriggeredTitles(summary) {
  const list = summary?.rules_never_tested;
  return Array.isArray(list) ? list : [];
}
