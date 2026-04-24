/**
 * src/lib/session-query.js
 *
 * 純函式：構 GET /api/session/recent 的 SQL query。拆出來方便單元測試。
 * v1.17.13 新增 `q` 參數（search summary + details ILIKE），修 Michelle 回報的
 * 「ownmind_search 搜不到剛 log 的 session 主題」bug（session_logs 獨立於 memories，
 * memory search 涵蓋不到）。
 */

export function buildSessionRecentQuery({
  userId,
  days = 7,
  tool = null,
  includeCompressed = false,
  q = null,
} = {}) {
  const parts = [`SELECT * FROM session_logs WHERE user_id = $1`];
  const values = [userId];
  let idx = 2;

  if (!includeCompressed) {
    parts.push(`AND compressed = false`);
  }

  parts.push(`AND created_at >= NOW() - INTERVAL '1 day' * $${idx}`);
  values.push(days);
  idx += 1;

  if (tool) {
    parts.push(`AND tool = $${idx}`);
    values.push(tool);
    idx += 1;
  }

  if (typeof q === 'string' && q.length > 0) {
    parts.push(`AND (summary ILIKE $${idx} OR COALESCE(details::text, '') ILIKE $${idx})`);
    values.push(`%${q}%`);
    idx += 1;
  }

  parts.push(`ORDER BY created_at DESC`);

  return { text: parts.join(' '), values };
}
