/**
 * pricing-lookup.js — model_pricing effective_date lookup logic
 *
 * Rule (S3):
 *   SELECT * FROM model_pricing
 *   WHERE tool = ? AND model = ? AND effective_date <= ?
 *   ORDER BY effective_date DESC, id DESC
 *   LIMIT 1
 *
 * Extracted into a pure function for easy unit testing (no DB dependency),
 * while also providing the DB-backed lookupPricing() for the route / aggregation job.
 *
 * Date comparisons are always normalized to YYYY-MM-DD strings for lexicographic
 * comparison, to avoid a pg DATE column returning a UTC-midnight Date object that
 * getDate() would misread as the previous day in UTC- timezones.
 */

import { query } from './db.js';

/**
 * Pick the effective price for a given date from a set of pricing rows.
 * Pure function, testable without a DB.
 *
 * @param {Array<object>} rows - any combination of pricing rows
 * @param {string} tool
 * @param {string} model
 * @param {string|Date} date - the date to look up (the event's occurrence date)
 * @returns {object|null} - the latest matching row, or null if none found
 */
export function pickPricing(rows, tool, model, date) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const target = toYmd(date);

  const matching = rows.filter((r) => {
    if (r.tool !== tool || r.model !== model) return false;
    return toYmd(r.effective_date) <= target;
  });

  if (matching.length === 0) return null;

  matching.sort((a, b) => {
    const ay = toYmd(a.effective_date);
    const by = toYmd(b.effective_date);
    if (ay !== by) return by < ay ? -1 : 1;       // effective_date DESC
    const aid = a.id ?? -Infinity;
    const bid = b.id ?? -Infinity;
    if (aid !== bid) return bid - aid;             // id DESC (UNIQUE should block same-day; defensive)
    return 0;
  });

  return matching[0];
}

/**
 * Compute the event cost (USD) — using an already-looked-up pricing row.
 * tokens are in actual token counts; pricing is per 1M tokens.
 *
 * Pricing rules:
 *   - input / output / cache_write / cache_read: each maps directly to its *_per_1m
 *   - reasoning_tokens: billed at output_per_1m (consistent with OpenAI GPT-5 billing;
 *     Claude / OpenCode have no reasoning_tokens field anyway, so the impact is 0)
 *
 * @param {object} pricing - the result returned by pickPricing()
 * @param {object} tokens - input_tokens / output_tokens / cache_creation_tokens /
 *                          cache_read_tokens / reasoning_tokens; missing values treated as 0
 * @returns {number|null} - the cost (USD), or null when pricing is null
 */
export function computeCost(pricing, tokens) {
  if (!pricing) return null;

  const n = (v) => Number(v ?? 0);
  const p = (v) => Number(v ?? 0);

  const input = n(tokens.input_tokens) * p(pricing.input_per_1m);
  const output = n(tokens.output_tokens) * p(pricing.output_per_1m);
  const cacheWrite = n(tokens.cache_creation_tokens) * p(pricing.cache_write_per_1m);
  const cacheRead = n(tokens.cache_read_tokens) * p(pricing.cache_read_per_1m);
  const reasoning = n(tokens.reasoning_tokens) * p(pricing.output_per_1m);

  return (input + output + cacheWrite + cacheRead + reasoning) / 1_000_000;
}

/**
 * DB-backed: look up the pricing for a single (tool, model, effective_date <= date).
 * Used by the aggregation job, called once per (tool, model, date) combo being recomputed.
 */
export async function lookupPricing(tool, model, date) {
  const result = await query(
    `SELECT id, tool, model, input_per_1m, output_per_1m,
            cache_write_per_1m, cache_read_per_1m, effective_date, notes
       FROM model_pricing
      WHERE tool = $1
        AND model = $2
        AND effective_date <= $3
      ORDER BY effective_date DESC, id DESC
      LIMIT 1`,
    [tool, model, toYmd(date)]
  );
  return result.rows[0] || null;
}

/**
 * Normalize the input to a YYYY-MM-DD string.
 * - string: if it already starts with YYYY-MM-DD, take the first 10 chars directly
 * - Date: read via UTC fields, to avoid timezone offset causing date drift
 */
function toYmd(d) {
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const parsed = new Date(d);
    return isoDate(parsed);
  }
  if (d instanceof Date) return isoDate(d);
  return isoDate(new Date(d));
}

function isoDate(date) {
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
