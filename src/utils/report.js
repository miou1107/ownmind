/**
 * 週/月報計算工具
 * 所有計算邏輯抽成純函式，方便測試
 */

/**
 * 計算指定 period 的時間範圍（Asia/Taipei，UTC+8）
 * @param {'week'|'month'} period
 * @param {number} offset - 0=本期, 1=上一期
 * @param {Date} [now] - 可注入，方便測試
 * @returns {{ start: Date, end: Date, label: string }}
 */
export function computePeriodRange(period, offset = 0, now = new Date()) {
  // 轉成 UTC+8 時間
  const tz = 8 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + tz);

  if (period === 'week') {
    // 週一為一週開始
    const day = local.getUTCDay(); // 0=Sunday
    const daysFromMonday = day === 0 ? 6 : day - 1;
    const monday = new Date(local);
    monday.setUTCDate(local.getUTCDate() - daysFromMonday - offset * 7);
    monday.setUTCHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    sunday.setUTCHours(23, 59, 59, 999);

    // 轉回 UTC
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
 * 把 friction_points 字串陣列群組化（前 20 字元 key，不分大小寫）
 * @param {string[]} frictions
 * @returns {{ text: string, count: number }[]} 降序排列
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
 * 從已查好的 DB rows 計算報表資料（純函式）
 * @param {object[]} sessionRows - session_logs rows（含 details）
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
    friction_issues_created: 0, // 由 job 填入，API 即時計算時為 0
    top_frictions: topFrictions,
    top_suggestions: topSuggestions,
    generated_at: new Date().toISOString(),
  };
}
