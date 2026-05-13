/**
 * Activity log INSERT 共用 helper（v1.17.99）
 *
 * 為什麼存在（解 v1.17.98 review I1）：
 *   v1.17.98 的 dedup INSERT 邏輯（NULL path 純 INSERT、有 id path ON CONFLICT）
 *   寫在 src/routes/activity.js 的 router handler 內。tests/activity-batch-dedup.test.js
 *   只能用 simplified copy 測、無法直接打到真 handler — 真 handler 跟邏輯漂移時測不出。
 *
 *   v1.17.99 把 dedup INSERT 抽到這個 pure module、handler import 它、test 也 import
 *   同一份。從此 test 跟真 handler 跑同一份程式、I1 limitation 解掉。
 *
 * Pure module — 無副作用（query function 由 caller 注入）、好測試、跨平台。
 */

// UUID v4 形式檢查（client_event_id 必須是合法 UUID 否則當沒帶處理）
// 防 client 亂塞 string、避免污染 (user_id, client_event_id) unique index
export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 把 client 傳的 client_event_id normalize 成「合法 UUID v4」或 null。
 * 非合法 UUID（包含空字串、非 string、v1/v3/v5、亂塞）一律當 NULL。
 */
export function normalizeClientEventId(raw) {
  return (typeof raw === 'string' && UUID_V4_REGEX.test(raw)) ? raw : null;
}

/**
 * 寫一筆 activity_logs。
 *
 * 拆兩條 path（v1.17.98 review B1）：
 *   - clientEventId === null → 純 INSERT（不帶 ON CONFLICT 子句、避免依賴
 *     partial unique index inference 對 NULL row 的邊界行為）
 *   - clientEventId 為合法 UUID v4 → INSERT 帶 ON CONFLICT DO NOTHING dedup
 *
 * @param {Function} query - PG query function (sql, params) → {rows: [...]}
 * @param {Object} args
 * @param {number} args.userId
 * @param {string} args.ts        - ISO 8601 timestamp
 * @param {string} args.event     - event type (e.g. 'iron_rule_compliance')
 * @param {string|null} args.tool
 * @param {string|null} args.source
 * @param {Object} args.details   - JSONB column
 * @param {string|null} args.clientEventId - normalize 過的 UUID v4 或 null
 * @returns {Promise<{inserted: boolean}>} inserted=false 代表 dedup 跳過
 */
export async function insertActivityLog(query, args) {
  const { userId, ts, event, tool, source, details, clientEventId } = args;

  if (clientEventId === null) {
    // NULL path：純 INSERT、不帶 client_event_id 欄位
    const r = await query(
      `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, ts, event, tool, source, details]
    );
    return { inserted: r.rows.length > 0 };
  }

  // 有 id path：ON CONFLICT DO NOTHING、partial unique index dedup
  const r = await query(
    `INSERT INTO activity_logs (user_id, ts, event, tool, source, details, client_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, client_event_id) WHERE client_event_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [userId, ts, event, tool, source, details, clientEventId]
  );
  // ON CONFLICT 跳過時 RETURNING 0 rows
  return { inserted: r.rows.length > 0 };
}
