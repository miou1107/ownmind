/**
 * bug-report-helpers — pure-function helpers for the v1.19.14 bug-report tool
 *
 * Implements OpenSpec proposal v1.19.14-bug-report-tool (spec §2.5, §2.7, §5, §6).
 *
 * Design notes:
 *   - pure functions (don't touch req / res directly), called by the route handler
 *   - functions that interact with the DB take an externally-passed query function (easy to mock in tests)
 *   - the flag-attaching logic lives here in one place, to avoid getting it wrong across multiple routes
 */

import { isValidFingerprint } from '../../shared/bug-fingerprints.js';

/**
 * Validate that confirm_string is the exact string "送出" (v4 design, server-side gate)
 *
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateConfirmString(value) {
  if (typeof value !== 'string') {
    return { ok: false, error: '需要使用者親口輸入「送出」才能建立回報' };
  }
  if (value !== '送出') {
    return { ok: false, error: '需要使用者親口輸入「送出」才能建立回報' };
  }
  return { ok: true };
}

/**
 * Add the suggest_report flag to an existing error body
 *
 * @param {Object} body - the JSON body originally being returned to the client
 * @param {string} fingerprint - a registered fingerprint
 * @param {Object} [options]
 * @param {string} [options.hint] - custom hint text (overrides the default)
 * @returns {Object} a new body with the flag added
 */
export function withReportSuggestion(body, fingerprint, options = {}) {
  if (!isValidFingerprint(fingerprint)) {
    throw new Error(
      `withReportSuggestion: unregistered or invalid fingerprint "${fingerprint}"; register it first in shared/bug-fingerprints.js`
    );
  }
  const hint = options.hint || '你覺得不該被擋？回報給開發者';
  return {
    ...body,
    suggest_report: true,
    bug_fingerprint: fingerprint,
    report_hint: hint,
  };
}

/**
 * Check whether the user is within a 24h spam block window
 *
 * @param {Function} query - DB query function (text, params) => Promise<{ rows }>
 * @param {number} userId
 * @returns {Promise<boolean>}
 */
export async function isUserInSpamBlock(query, userId) {
  const result = await query(
    `SELECT 1 FROM bug_report_spam_blocks
      WHERE user_id = $1 AND blocked_until > now()
      LIMIT 1`,
    [userId]
  );
  return result.rows.length > 0;
}

/**
 * Check whether the user declined this fingerprint in the past 24h (cooldown)
 *
 * @param {Function} query
 * @param {number} userId
 * @param {string} fingerprint
 * @returns {Promise<boolean>}
 */
export async function hasDeclinedRecently(query, userId, fingerprint) {
  const result = await query(
    `SELECT 1 FROM bug_report_declines
      WHERE user_id = $1
        AND bug_fingerprint = $2
        AND declined_at > now() - INTERVAL '24 hours'
      LIMIT 1`,
    [userId, fingerprint]
  );
  return result.rows.length > 0;
}

/**
 * Count the user's reports with the same fingerprint in the past 1h
 *
 * @param {Function} query
 * @param {number} userId
 * @param {string} fingerprint
 * @returns {Promise<number>}
 */
export async function countSameFingerprintInLastHour(query, userId, fingerprint) {
  const result = await query(
    `SELECT COUNT(*)::text AS count FROM bug_reports
      WHERE user_id = $1
        AND bug_fingerprint = $2
        AND created_at > now() - INTERVAL '1 hour'`,
    [userId, fingerprint]
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}

/**
 * Decide whether to reject with a 429 because "3 reports with the same fingerprint within 1h"
 * (the interface layer's first line of defense, to stop the AI from over-eagerly resending the same error)
 *
 * @param {Function} query
 * @param {number} userId
 * @param {string} fingerprint
 * @returns {Promise<{ reject: boolean, message?: string, current_count?: number }>}
 */
export async function shouldRejectByFingerprintRateLimit(query, userId, fingerprint) {
  const count = await countSameFingerprintInLastHour(query, userId, fingerprint);
  if (count >= 3) {
    return {
      reject: true,
      message: '同類錯誤回報太頻繁、請稍後再試（1 小時內已收 3 筆）',
      current_count: count,
    };
  }
  return { reject: false, current_count: count };
}

/**
 * Combined check: whether to attach the suggest_report flag to an error response.
 * Must pass: not within a spam block AND has not declined this fingerprint in the past 24h
 *
 * @param {Function} query
 * @param {number} userId
 * @param {string} fingerprint
 * @returns {Promise<boolean>}
 */
export async function isSuggestReportEligible(query, userId, fingerprint) {
  const [inBlock, declined] = await Promise.all([
    isUserInSpamBlock(query, userId),
    hasDeclinedRecently(query, userId, fingerprint),
  ]);
  return !inBlock && !declined;
}
