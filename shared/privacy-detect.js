/**
 * privacy-detect — pure-function detector for user privacy (PII) patterns.
 *
 * Introduced in v1.19.7. Neutralized in v1.19.10 (no longer tied to a
 * specific user's iron-rule code).
 *
 * Used by the reply-lint hook: scans each AI reply at end of turn and
 * emits a 'privacy_check' event when something matches. Whether to block
 * is decided by the user's own iron rule (e.g. a privacy rule binds to this
 * event; other users can opt in by writing a similar rule).
 *
 * Exception (when a match doesn't count):
 *   When the user's own prompt also contains the same string, the user
 *   themselves shared it; quoting it back is necessary communication and
 *   not a leak.
 *
 * Design points:
 * - Conservative detection (prefers misses over false positives): the
 *   reply-lint pipeline is high-frequency, so a wrong block means forcing
 *   the AI to rewrite content for nothing.
 * - Pure function: no IO, no throws, easily tested.
 * - Patterns: Taiwan national ID (with checksum), email, Taiwan mobile
 *   (09 prefix).
 *
 * @param {string|*} text - the AI reply text to scan
 * @param {Object} [options]
 * @param {string[]} [options.userPrompts] - recent user prompts, used for
 *   the exception described above
 * @returns {{ detected: boolean, matches: Array<{type, value}> }}
 *   - detected: whether anything matched
 *   - matches: matched items (deduped); type is 'tw_id' / 'email' / 'phone_tw_mobile'
 */
export function detectPrivacyLeak(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { detected: false, matches: [] };
  }

  const userPrompts = Array.isArray(options?.userPrompts)
    ? options.userPrompts.filter((s) => typeof s === 'string')
    : [];
  const userHaystack = userPrompts.join('\n');

  const seen = new Set();
  const matches = [];

  for (const { name, pattern, validate } of PRIVACY_PATTERNS) {
    // Each pattern gets a fresh RegExp (avoid lastIndex sharing).
    const re = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (validate && !validate(value)) continue;
      if (userHaystack && userHaystack.includes(value)) continue;
      // v1.19.7 code-review I-2: emails get an extra allowlist pass
      // (example.com / localhost / noreply etc. are common dev/doc fake
      // addresses and do not count as PII).
      if (name === 'email' && isAllowlistedEmail(value)) continue;
      const dedupKey = `${name}:${value}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      matches.push({ type: name, value });
    }
  }

  return { detected: matches.length > 0, matches };
}

/**
 * v1.19.7 code-review I-2: email allowlist.
 *
 * Excludes (i.e. not "personal contact info"):
 *   - Fake domains: example.com / example.org / example.net / .test /
 *     .invalid / .local / localhost.
 *   - System sender prefixes: noreply / no-reply / donotreply (these don't
 *     reply, so they aren't real contact points).
 *
 * Goal: avoid triggering privacy_check when AI explains code, git records
 * (e.g. Co-Authored-By tags), or documentation examples. Left for v1.19.10
 * observation; expand later based on real false-positive reports.
 *
 * @param {string} email - email string that already matched the regex
 * @returns {boolean} true = on allowlist, treat as non-PII
 */
function isAllowlistedEmail(email) {
  const lower = email.toLowerCase();
  const atIdx = lower.indexOf('@');
  if (atIdx <= 0) return false;
  const local = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);

  for (const prefix of EMAIL_ALLOWLIST_LOCAL) {
    if (local === prefix || local.startsWith(prefix + '.') || local.startsWith(prefix + '-') || local.startsWith(prefix + '_')) {
      return true;
    }
  }
  for (const d of EMAIL_ALLOWLIST_DOMAINS) {
    if (domain === d || domain.endsWith('.' + d)) return true;
  }
  return false;
}

const EMAIL_ALLOWLIST_DOMAINS = [
  'example.com',
  'example.org',
  'example.net',
  'localhost',
  'test',
  'invalid',
  'local',
];

const EMAIL_ALLOWLIST_LOCAL = [
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
];

/**
 * Privacy pattern table.
 *
 * Design:
 * - National ID uses the official Taiwan checksum, virtually eliminating
 *   false positives.
 * - Email uses the standard shape (local + @ + domain + ≥2-char TLD).
 * - Mobile only matches the Taiwan 09 form (international +886-9... is
 *   out of scope to avoid matching unrelated phone-number-style strings).
 */
/**
 * Privacy-type display labels (used in banners / reason strings).
 *
 * v1.19.12 exposed this as a sibling export of PRIVACY_PATTERNS.
 * When adding a new detection type, update this map too — otherwise the
 * banner shows the raw type code (e.g. 'tw_id').
 *
 * Chinese labels kept intentionally to match the localized banner output.
 */
export const PRIVACY_TYPE_LABELS = Object.freeze({
  tw_id: '身分證',
  email: '電子信箱',
  phone_tw_mobile: '手機',
});

const PRIVACY_PATTERNS = [
  {
    name: 'tw_id',
    // One letter + gender digit 1/2 + 8 digits.
    pattern: /\b[A-Z][12]\d{8}\b/g,
    validate: validateTwId,
  },
  {
    name: 'email',
    // Simplified RFC: [letters/digits/.+%-]+@[letters/digits/.-]+\.[letters]{2,}.
    // \b plus a ≥2-char TLD reduces false positives.
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    name: 'phone_tw_mobile',
    // Taiwan mobile: 09 prefix + 8 digits, optional - or whitespace separator.
    // Examples: 0912345678 / 0912-345-678 / 0912 345 678.
    pattern: /\b09\d{2}[-\s]?\d{3}[-\s]?\d{3}\b/g,
    validate: validateTwMobile,
  },
];

/**
 * Taiwan national-ID official checksum:
 *   1. First letter maps to a two-digit number (A=10, B=11, …).
 *   2. tens digit ×1, ones digit ×9, summed into `sum`.
 *   3. Digits 2..9 weighted 8, 7, 6, 5, 4, 3, 2, 1, added to `sum`.
 *   4. Digit 10 is the check digit: sum + check_digit mod 10 == 0 → valid.
 *
 * Accuracy ≈ 1/10 false positive rate, combined with the format match this
 * almost never misfires in practice.
 */
function validateTwId(id) {
  if (!/^[A-Z][12]\d{8}$/.test(id)) return false;
  const letterValues = {
    A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34,
    J: 18, K: 19, L: 20, M: 21, N: 22, O: 35, P: 23, Q: 24, R: 25,
    S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33,
  };
  const v = letterValues[id[0]];
  if (typeof v !== 'number') return false;
  let sum = Math.floor(v / 10) * 1 + (v % 10) * 9;
  const weights = [8, 7, 6, 5, 4, 3, 2, 1];
  for (let i = 0; i < 8; i++) {
    sum += parseInt(id[i + 1], 10) * weights[i];
  }
  sum += parseInt(id[9], 10);
  return sum % 10 === 0;
}

/**
 * Extra check for Taiwan mobile numbers (filters out fakes like
 * 0911111111 made of repeated digits):
 *   - All-same trailing digits (0900000000 / 0911111111) → treated as fake.
 */
function validateTwMobile(raw) {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length !== 10) return false;
  if (!digits.startsWith('09')) return false;
  // Trailing 8 digits all equal (test pattern) → not PII.
  const tail = digits.slice(2);
  if (/^(\d)\1{7}$/.test(tail)) return false;
  return true;
}
