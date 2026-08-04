// v1.26.56 — presentation math for the bar and daily charts.
//
// Extracted from JSX so the division is executed by a test. The denominator
// guard is the reason: an all-zero distribution divides by zero, and `NaN%` in
// a width style renders as a full-width bar in some engines — the loudest
// possible way to display "nothing happened".

/** Coerce pg's string counts (COUNT(*) comes back as text) to a finite number. */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pctOf(count, max) {
  if (max <= 0) return 0;
  return Number(((count / max) * 100).toFixed(1));
}

/**
 * Turn a `{ key: count }` distribution into sorted, proportional rows.
 * Ordered by count descending, because these charts rank rather than sequence.
 * Returns `[]` for an absent or empty map — the caller renders the "no data"
 * line, which is a statement, not an empty box.
 */
export function barChartRows(data) {
  if (!data || typeof data !== 'object') return [];
  const entries = Object.entries(data).map(([key, v]) => ({ key, count: toCount(v) }));
  if (entries.length === 0) return [];
  const max = Math.max(...entries.map((e) => e.count));
  return entries
    .sort((a, b) => b.count - a.count)
    .map((e) => ({ key: e.key, count: e.count, pct: pctOf(e.count, max) }));
}

/**
 * Turn `[{ date, count }]` into proportional rows, order preserved.
 *
 * Deliberately not sorted: this is a time series, and ranking it by size would
 * turn "activity fell off after the 3rd" into "the 3rd was the busiest day".
 */
export function dailyChartRows(daily) {
  if (!Array.isArray(daily) || daily.length === 0) return [];
  const rows = daily.map((d) => ({ date: d.date, count: toCount(d.count) }));
  const max = Math.max(...rows.map((r) => r.count));
  return rows.map((r) => ({ ...r, pct: pctOf(r.count, max) }));
}
