/**
 * Random password generator — v1.19.10
 *
 * Extracted from v1.19.9 admin-password-reset.js so multiple places can share it
 * (admin user creation, default-password seeding).
 *
 * Rules:
 *   - Default 12 chars, configurable length
 *   - Character set drops easily-confused 0/O/I/l/1
 *   - Forces at least 1 uppercase, 1 lowercase, 1 digit
 *   - Uses crypto.randomBytes for randomness (not Math.random)
 *   - Fisher-Yates shuffle avoids fixing the first 3 chars to upper/lower/digit
 */
import { randomBytes } from 'crypto';

const DEFAULT_LEN = 12;
const MIN_LEN = 8;

/**
 * Generate a random password.
 *
 * @param {number} [len=12] - Length, minimum 8
 * @returns {string}
 */
export function generateRandomPassword(len = DEFAULT_LEN) {
  if (typeof len !== 'number' || len < MIN_LEN) len = DEFAULT_LEN;

  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // drops I / O
  const lower = 'abcdefghjkmnpqrstuvwxyz';   // drops i / l / o
  const digit = '23456789';                  // drops 0 / 1
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
