/**
 * client/src/pages/Usage/report-query.js
 *
 * v1.32.4 — the pure half of useMeReport: the fixed windows and the query string for a
 * range state. No React and no api import, so node --test can load it.
 */
export const RANGES = ['7d', '14d', '30d', 'all'];
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The query string for a range state, or null when the custom range is not usable yet. */
export function reportQuery({ custom, range, start, end }) {
  if (!custom) return `range=${encodeURIComponent(range)}`;
  const complete = ISO_DATE.test(start) && ISO_DATE.test(end);
  if (!complete || start > end) return null;
  return `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
}
