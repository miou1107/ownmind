/**
 * Weekly/monthly report computation utilities
 * All computation logic is extracted into pure functions for easy testing.
 */

/**
 * Compute the time range for a given period (Asia/Taipei, UTC+8)
 * @param {'week'|'month'} period
 * @param {number} offset - 0=current period, 1=previous period
 * @param {Date} [now] - injectable for testing
 * @returns {{ start: Date, end: Date, label: string }}
 */
export function computePeriodRange(period, offset = 0, now = new Date()) {
  // convert to UTC+8 time
  const tz = 8 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + tz);

  if (period === 'week') {
    // Monday is the start of the week
    const day = local.getUTCDay(); // 0=Sunday
    const daysFromMonday = day === 0 ? 6 : day - 1;
    const monday = new Date(local);
    monday.setUTCDate(local.getUTCDate() - daysFromMonday - offset * 7);
    monday.setUTCHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    sunday.setUTCHours(23, 59, 59, 999);

    // convert back to UTC
    const start = new Date(monday.getTime() - tz);
    const end = new Date(sunday.getTime() - tz);
    const label = `${monday.toISOString().slice(0, 10)} ~ ${sunday.toISOString().slice(0, 10)}`;
    return { start, end, label };
  }

  if (period === 'month') {
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() - offset;

    const firstDay = new Date(Date.UTC(year, month, 1) - tz);
    const lastDay = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999) - tz);

    const localFirst = new Date(firstDay.getTime() + tz);
    const localLast = new Date(lastDay.getTime() + tz);
    const label = `${localFirst.toISOString().slice(0, 10)} ~ ${localLast.toISOString().slice(0, 10)}`;
    return { start: firstDay, end: lastDay, label };
  }

  throw new Error(`Unknown period: ${period}`);
}

/**
 * Group an array of friction_points strings (key = first 20 chars, case-insensitive)
 * @param {string[]} frictions
 * @returns {{ text: string, count: number }[]} sorted descending
 */
export function groupFrictions(frictions) {
  const map = new Map();
  for (const f of frictions) {
    if (!f || typeof f !== 'string') continue;
    const key = f.toLowerCase().trim().slice(0, 20);
    if (!map.has(key)) {
      map.set(key, { text: f.trim(), count: 0 });
    }
    map.get(key).count++;
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * Compute report data from already-queried DB rows (pure function)
 *
 * `sessions_analyzed` exists because an empty `top_frictions` had four possible
 * meanings and one sentence: no session at all, sessions without the reflection
 * fields, a genuine absence of friction, or a period old enough that
 * compressOldSessions deleted the rows. The caller pairs this with a count of every
 * row in the window to tell those apart.
 *
 * The two auto-created counts are deliberately absent from this return value. They
 * need their own database query, so a pure function cannot know them; emitting a
 * hardcoded 0 meant any caller that forgot to overwrite it published a confident
 * wrong number rather than an obviously missing one.
 *
 * @param {object[]} sessionRows - session_logs rows (including details)
 * @param {number} newMemoriesCount
 * @param {string} periodLabel
 * @returns {object} report data
 */
export function computeReportData(sessionRows, newMemoriesCount, periodLabel) {
  const frictions = [];
  const suggestions = [];

  for (const row of sessionRows) {
    const d = row.details;
    if (!d) continue;
    if (d.friction_points && typeof d.friction_points === 'string') {
      frictions.push(d.friction_points);
    }
    if (d.suggestions && typeof d.suggestions === 'string') {
      suggestions.push(d.suggestions);
    }
  }

  const topFrictions = groupFrictions(frictions).slice(0, 10);
  const topSuggestions = groupFrictions(suggestions).slice(0, 10);

  return {
    period: periodLabel,
    new_memories: newMemoriesCount,
    sessions_analyzed: sessionRows.length,
    top_frictions: topFrictions,
    top_suggestions: topSuggestions,
    generated_at: new Date().toISOString(),
  };
}
