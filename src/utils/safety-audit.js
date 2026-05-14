/**
 * safety-audit.js — v1.18.9 寫安全告警紀錄到 usage_audit_log
 *
 * 設計來源：openspec/changes/v1.18.5-block-feedback-and-safety-alerts/spec.md B
 *
 * 為什麼存在：
 *   - 抽出 4 種 v1.18.9 安全告警的寫紀錄邏輯、各 wire 點共用
 *   - 強制 event_type 限定在 SAFETY_ALERT_TYPES，避免亂寫
 *   - 不阻塞主流程：寫失敗只 log warn、不拋
 *
 * 跟既有 src/routes/usage/events.js 的 writeAudit() 並存：
 *   - 既有 writeAudit 寫的是 unknown_model / token_regression 等使用量稽核
 *   - 本檔 writeSafetyAudit 寫的是 4 種安全告警
 *   - 未來如要合併、改 events.js / exemptions.js 也用本 helper
 */

import logger from './logger.js';
import { SAFETY_ALERT_TYPES } from '../lib/safety-detect.js';

/**
 * 寫一筆安全告警到 usage_audit_log。
 *
 * @param {Object} args
 * @param {Function} args.query - PG query function（注入方便測試）
 * @param {number} args.userId - 受影響使用者編號
 * @param {string|null} args.tool - 觸發告警的工具名（如 'claude-code'、null 也可）
 * @param {string} args.eventType - 必須是 SAFETY_ALERT_TYPES 之一
 * @param {Object} args.details - 告警詳情（JSONB 寫入）
 * @returns {Promise<{written: boolean, reason?: string}>}
 */
export async function writeSafetyAudit({ query, userId, tool, eventType, details }) {
  if (!SAFETY_ALERT_TYPES.includes(eventType)) {
    logger.warn('writeSafetyAudit: 未知 event_type、拒絕寫入', { eventType, userId });
    return { written: false, reason: 'unknown_event_type' };
  }
  if (typeof userId !== 'number' || userId <= 0) {
    logger.warn('writeSafetyAudit: userId 不合法、拒絕寫入', { userId });
    return { written: false, reason: 'invalid_user_id' };
  }
  try {
    await query(
      `INSERT INTO usage_audit_log (user_id, tool, event_type, details)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [userId, tool ?? null, eventType, JSON.stringify(details ?? {})],
    );
    return { written: true };
  } catch (err) {
    // 不拋 — 安全告警寫不進去不該擋主流程
    logger.error('writeSafetyAudit: 寫入失敗', {
      error: err?.message,
      eventType,
      userId,
    });
    return { written: false, reason: 'db_error' };
  }
}
