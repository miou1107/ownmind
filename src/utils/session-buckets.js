/**
 * Naming the absence in session_logs groupings (v1.26.61).
 *
 * `session_logs.tool` and `.model` are nullable, and v1.26.61 made `model` genuinely
 * optional so a missing one no longer discards the whole session record. That turns an
 * absent model into something the statistics dashboard has to display.
 *
 * The default JavaScript behaviour is the trap: `byModel[row.model] += n` on a NULL model
 * produces a bucket keyed `"null"` — a chart category named after a coercion, sitting
 * beside real model names as though it were one. That is the "absence rendered as a value"
 * defect Requirement 7 of the console consolidation exists to prevent, so making `model`
 * optional without this would have created a fresh instance of it in the same release.
 */

/**
 * The bucket unreported rows are counted under.
 *
 * Deliberately not 'unknown' or 'null': both are plausible strings for a real tool or
 * model, and a collision would silently merge measured rows with unmeasured ones. In
 * Chinese for the same reason the other user-facing labels are — this string is rendered.
 */
export const UNREPORTED = '未回報';

/**
 * @param {*} value A `tool` or `model` value straight from the database.
 * @returns {string} The value, or the named bucket when it carries nothing.
 */
export function bucketLabel(value) {
  if (value === undefined || value === null) return UNREPORTED;
  if (typeof value === 'string' && value.trim() === '') return UNREPORTED;
  return value;
}
