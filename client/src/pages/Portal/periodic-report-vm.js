// v1.26.59 — 週報月報 (consolidation Stage 7). Pure view-model for the report page.
//
// The whole point of this module is that an empty list has four causes and the
// legacy tab printed one sentence for all of them. Deciding which one it is needs
// the two session counts the endpoint gained in this release, so the decision is
// here — executed by tests — rather than inline in JSX where nothing runs it.

/** Both periods the endpoint accepts. */
export const PERIODS = ['week', 'month'];

/** How far back the legacy tab could look; the endpoint allows up to 52. */
export const OFFSETS = [0, 1, 2, 3];

/** The three number cards, in the order the legacy tab showed them. */
const CARD_KEYS = ['new_memories', 'friction_issues_created', 'suggestion_actions_created'];

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Milliseconds for an ISO instant, or null when it is missing or unparseable. */
function instant(v) {
  if (typeof v !== 'string' || v === '') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** The server's own label for the window, or null when it did not send one. */
export function periodLabelOf(report) {
  return typeof report?.period === 'string' && report.period !== '' ? report.period : null;
}

/**
 * Which kind of empty a list is.
 *
 *   ok              — there are rows
 *   no_sessions     — nothing was logged in this period; friction was never measured
 *   compressed_only — the only rows left are compression summaries, so the notes
 *                     existed and retention deleted them. The opposite of no_details,
 *                     and they used to be indistinguishable: found in adversarial
 *                     review, where the page told the reader their team had failed to
 *                     fill in fields that had in fact been discarded by design
 *   no_details      — live sessions were logged but carried no reflection fields
 *   measured_empty  — sessions were analysed and genuinely held none: a real zero
 *   unknown         — the server did not say, so neither do we
 *
 * `sessions_total` counts live rows only, so `no_details` cannot be triggered by a
 * summary row the server itself excluded from the lists.
 *
 * @param {object|null} report
 * @param {'top_frictions'|'top_suggestions'} key
 */
export function listStateVm(report, key) {
  const rows = Array.isArray(report?.[key]) ? report[key] : [];
  const sessionsTotal = numberOrNull(report?.sessions_total);
  const sessionsAnalyzed = numberOrNull(report?.sessions_analyzed);
  const sessionsCompressed = numberOrNull(report?.sessions_compressed);
  const base = { rows, sessionsTotal, sessionsAnalyzed, sessionsCompressed };

  if (rows.length > 0) return { ...base, state: 'ok' };
  // Guessing from an absent count would recreate the one-sentence-for-every-cause bug
  // this module exists to remove. sessions_compressed is not required: a server that
  // predates it is simply a server with nothing to say about compression.
  if (sessionsTotal === null || sessionsAnalyzed === null) return { ...base, state: 'unknown' };
  if (sessionsTotal === 0) {
    return { ...base, state: sessionsCompressed > 0 ? 'compressed_only' : 'no_sessions' };
  }
  if (sessionsAnalyzed === 0) return { ...base, state: 'no_details' };
  return { ...base, state: 'measured_empty' };
}

/**
 * Whether session detail for this window has been compressed away.
 *
 * compressOldSessions merges rows older than the retention window into one monthly
 * summary with no `details` and deletes the originals, and the report query filters
 * `compressed = false`. So for an old window the lists are not merely empty, they
 * are unknowable — and a window that straddles the cutoff returns a partial list
 * that looks like a whole one, which is the case worth warning about most.
 *
 * The cutoff comes from the server because the retention constant is the server's
 * and a skewed browser clock must not change what the page claims.
 */
export function retentionVm(report) {
  const start = instant(report?.period_start);
  const end = instant(report?.period_end);
  const cutoff = instant(report?.detail_retention_cutoff);
  if (start === null || end === null || cutoff === null) return { known: false };
  if (cutoff > end) return { known: true, affected: true, whole: true };
  if (cutoff > start) return { known: true, affected: true, whole: false };
  return { known: true, affected: false };
}

/**
 * The three number cards. A count the server did not send reads as absent rather
 * than as 0 — that difference is the defect this stage fixes, so it is carried by
 * the data and not by a `?? '—'` at the render site.
 */
export function cardsVm(report) {
  return CARD_KEYS.map((key) => {
    const value = numberOrNull(report?.[key]);
    return { key, value, absent: value === null };
  });
}
