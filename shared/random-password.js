/**
 * 隨機密碼產生器 — v1.19.10
 *
 * 從 v1.19.9 admin-password-reset.js 抽出來、給多處共用（admin 建 user、seed 預設密碼）。
 *
 * 規則：
 *   - 預設 12 字、可指定長度
 *   - 字符集去掉容易混淆的 0/O/I/l/1
 *   - 強制至少含 1 個大寫、1 個小寫、1 個數字
 *   - 用 crypto.randomBytes 確保隨機性（非 Math.random）
 *   - Fisher-Yates 洗牌避免前 3 位固定為 upper/lower/digit
 */
import { randomBytes } from 'crypto';

const DEFAULT_LEN = 12;
const MIN_LEN = 8;

/**
 * 產隨機密碼
 *
 * @param {number} [len=12] - 長度、最少 8
 * @returns {string}
 */
export function generateRandomPassword(len = DEFAULT_LEN) {
  if (typeof len !== 'number' || len < MIN_LEN) len = DEFAULT_LEN;

  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去 I / O
  const lower = 'abcdefghjkmnpqrstuvwxyz';   // 去 i / l / o
  const digit = '23456789';                  // 去 0 / 1
  const alphabet = upper + lower + digit;

  const bytes = randomBytes(len);
  const chars = [];
  chars.push(upper[bytes[0] % upper.length]);
  chars.push(lower[bytes[1] % lower.length]);
  chars.push(digit[bytes[2] % digit.length]);
  for (let i = 3; i < len; i++) {
    chars.push(alphabet[bytes[i] % alphabet.length]);
  }

  const shuffleBytes = randomBytes(len);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = shuffleBytes[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
