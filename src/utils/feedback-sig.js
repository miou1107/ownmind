/**
 * feedback-sig.js — 阻擋誤殺回饋連結 HMAC 簽名（v1.18.9）
 *
 * 設計來源：openspec/changes/v1.18.5-block-feedback-and-safety-alerts/spec.md A.1
 *
 * 為什麼存在：
 *   reply-lint 偵測到鐵律違反時、印一段 markdown 連結讓 user 回報「擋錯了」。
 *   連結 URL query 帶 sig 證明此 URL 是 server 印出來的、不是被偽造的。
 *
 * 為什麼用 derive 而不是新環境變數：
 *   既有 ENCRYPTION_KEY 已是 fail-fast pattern (src/utils/crypto.js)、
 *   sig secret 從 ENCRYPTION_KEY HMAC 衍生，不需新增環境變數、零部署成本。
 *   不同 purpose 的 derive 不會互相影響（HMAC 性質）。
 *
 * Pure module — secret 跟 now 都由 caller 注入，方便 test 控制時間 / 不依賴 env。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const SECONDS_PER_DAY = 86400;
const SECRET_DERIVE_LABEL = 'ownmind-feedback-sig-v1';
const SIG_HEX_LENGTH = 16; // 8 byte HMAC truncate

/**
 * 從 ENCRYPTION_KEY derive 簽名 secret。
 * @param {string} encryptionKey - 既有 ENCRYPTION_KEY 環境變數
 * @returns {string} 64-char hex (256 bit)
 */
export function deriveSecret(encryptionKey) {
  return createHmac('sha256', encryptionKey).update(SECRET_DERIVE_LABEL).digest('hex');
}

/**
 * 把 unix ms timestamp 轉成 day_bucket（floor 到天）。
 * 用於讓 sig 在 24h 內有效、隔天自動過期。
 * @param {number} unixMs - timestamp in milliseconds
 * @returns {number} 整數 day_bucket
 */
export function dayBucket(unixMs) {
  return Math.floor(unixMs / 1000 / SECONDS_PER_DAY);
}

/**
 * 簽名 feedback URL。
 * @param {string} eventId - 原本被擋的事件 id（client_event_id）
 * @param {number} userId - 簽給哪個 user（通常 = req.user.id）
 * @param {number} day - dayBucket(now)
 * @param {string} secret - deriveSecret() 結果
 * @returns {string} 16-char hex sig
 */
export function signFeedback(eventId, userId, day, secret) {
  const payload = `${eventId}|${userId}|${day}`;
  return createHmac('sha256', secret).update(payload).digest('hex').slice(0, SIG_HEX_LENGTH);
}

/**
 * 驗證 feedback URL 的 sig。
 *
 * @param {string} eventId
 * @param {number} userId
 * @param {string} sig - URL 帶來的 sig
 * @param {string} secret
 * @param {number} nowMs - 現在時間 ms
 * @returns {{ok: true} | {ok: false, reason: 'invalid_sig'|'expired'}}
 */
export function verifyFeedback(eventId, userId, sig, secret, nowMs) {
  // sig 必須是 16-char hex；長度 / 字元錯誤都當 invalid_sig（不洩漏細節）
  if (typeof sig !== 'string' || sig.length !== SIG_HEX_LENGTH || !/^[0-9a-f]+$/i.test(sig)) {
    return { ok: false, reason: 'invalid_sig' };
  }

  const today = dayBucket(nowMs);

  // 嘗試 today 跟 today-1（簽名跨日的 grace window）
  // today+N（未來）一律拒、防 server 時鐘被攻擊者操縱
  for (const day of [today, today - 1]) {
    const expected = signFeedback(eventId, userId, day, secret);
    let match = false;
    try {
      // timingSafeEqual 要求兩個 buffer 同長、不同長就 throw
      match = timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      // 應該不會發生（前面已 validate sig 是 16-char hex），保險
      return { ok: false, reason: 'invalid_sig' };
    }
    if (match) {
      // sig 對上了：判斷是 today 還是 yesterday
      // today: 24h 內、ok
      // yesterday: 算「過期」，但簽名是真的（區分 expired vs invalid_sig 給更好的錯誤訊息）
      if (day === today) return { ok: true };
      return { ok: false, reason: 'expired' };
    }
  }

  return { ok: false, reason: 'invalid_sig' };
}
