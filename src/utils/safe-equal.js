import { createHash, timingSafeEqual } from 'crypto';

/**
 * Compare a secret the caller sent against the one the server holds, in time that does not
 * depend on how many leading characters match.
 *
 * `===` stops at the first differing character, so how long a wrong guess takes to be
 * refused leaks how much of it was right. Both sides are hashed first: timingSafeEqual needs
 * equal lengths, and comparing lengths directly would leak the secret's length instead.
 *
 * @param {unknown} given     what the request carried (anything; non-strings never match)
 * @param {string}  expected  the configured secret
 * @returns {boolean}
 */
export function safeEqual(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected === '') return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
