/**
 * block-feedback.js — 處理「擋錯了」誤殺回饋的核心邏輯（v1.18.9）
 *
 * 設計來源：openspec/changes/v1.18.5-block-feedback-and-safety-alerts/spec.md A.2
 *
 * Pure function — query / secret / now / user 都由 caller 注入、
 * 跟 src/lib/memory-sync.js 同 pattern、test 直接 import 同份程式。
 *
 * 兩種授權路徑：
 *   - CLI: Bearer token 驗過、req.user 已注入 → 跳過 sig 驗證
 *   - Web: URL 帶 sig + user_id → 用 verifyFeedback 驗
 */

import { verifyFeedback } from '../utils/feedback-sig.js';
import { insertActivityLog, normalizeClientEventId } from '../utils/activity-insert.js';

const MAX_REASON_LEN = 500;
const DEDUP_WINDOW_MINUTES = 5;

/**
 * @param {Object} args
 * @param {Object} args.body - request body { event_id, sig?, user_id?, reason?, client_event_id? }
 * @param {Function} args.query - PG query function (sql, params) → {rows, rowCount}
 * @param {string} args.secret - feedback HMAC secret (deriveSecret() 結果)
 * @param {number} args.now - current unix ms (caller 注入方便測試)
 * @param {Object|null} args.user - 已驗證的 user 物件（CLI path）；null = web path
 * @returns {Promise<{status: number, body: Object}>}
 */
export async function handleBlockFeedback({ body, query, secret, now, user }) {
  // 1. 校驗 event_id
  const eventId = body?.event_id;
  if (!eventId || typeof eventId !== 'string') {
    return { status: 400, body: { error: 'event_id is required' } };
  }

  // 2. 解析授權路徑
  let resolvedUserId;
  let source;

  if (user) {
    // CLI path：Bearer 已驗
    resolvedUserId = user.id;
    source = 'cli';
  } else if (body?.sig) {
    // Web path：sig 驗證
    const userIdNum = Number(body.user_id);
    if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
      return { status: 400, body: { error: 'user_id is required for sig auth' } };
    }
    const v = verifyFeedback(eventId, userIdNum, body.sig, secret, now);
    if (!v.ok) {
      const status = v.reason === 'expired' ? 410 : 401;
      return { status, body: { error: v.reason } };
    }
    resolvedUserId = userIdNum;
    source = 'web';
  } else {
    return { status: 401, body: { error: 'no auth provided' } };
  }

  // 3. 驗 event_id 確實存在且屬於這個 user
  // （client_event_id 是 reply-lint 寫進 activity_logs 的、user_id 已綁定）
  const evt = await query(
    `SELECT id FROM activity_logs
     WHERE client_event_id = $1 AND user_id = $2
     LIMIT 1`,
    [eventId, resolvedUserId]
  );
  if (evt.rowCount === 0) {
    return { status: 404, body: { error: 'event not found' } };
  }

  // 4. dedup：5 分鐘內同 (user, original_event_id) 重複回報擋下
  const dup = await query(
    `SELECT id FROM activity_logs
     WHERE event = 'block_feedback'
       AND user_id = $1
       AND details->>'original_event_id' = $2
       AND ts > NOW() - INTERVAL '${DEDUP_WINDOW_MINUTES} minutes'
     LIMIT 1`,
    [resolvedUserId, eventId]
  );
  if (dup.rowCount > 0) {
    return { status: 409, body: { error: 'already reported within 5 minutes' } };
  }

  // 5. 寫 block_feedback event
  const reason = (typeof body.reason === 'string' && body.reason.length > 0)
    ? body.reason.slice(0, MAX_REASON_LEN)
    : null;

  const details = {
    original_event_id: eventId,
    source,
    ...(reason ? { reason } : {}),
  };

  await insertActivityLog(query, {
    userId: resolvedUserId,
    ts: new Date(now).toISOString(),
    event: 'block_feedback',
    tool: null,
    source,
    details,
    clientEventId: normalizeClientEventId(body.client_event_id),
  });

  return { status: 200, body: { ok: true } };
}
