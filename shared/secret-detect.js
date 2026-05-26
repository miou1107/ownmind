/**
 * secret-detect — detects values that look like sensitive data.
 *
 * Introduced in v1.19.1. Corresponds to OpenSpec proposal
 * v1.19.1-secret-tool-routing §2.1.
 *
 * Used at the memory API write boundary (POST/PUT /api/memory):
 * when a password / token / API key is detected, return detected=true,
 * the route blocks the memory write, and the caller is asked to use the
 * /api/secret route instead.
 *
 * Design principles:
 * - Conservative detection: prefers misses (false negative) over wrong
 *   blocks (false positive). The memory API is a high-frequency channel;
 *   a wrong block jams normal memory writes.
 * - Detection order: bypass → regex → keyword → length heuristic.
 *   Regex is the most precise and runs first; the heuristic is the
 *   loosest and serves as a safety net.
 * - Pure function: no DB / fs access, no exceptions; easy to test.
 *
 * v1.19.13 changes:
 *   Value-side keyword detection changed from "block if value contains the
 *   word password" to "block only when the value matches an assignment
 *   pattern (KEY: VALUE or KEY=VALUE) and the value is ≥8 chars". Reason:
 *   reference documents mention secret names (e.g.
 *   anydesk.bot_kkvin.unattended_password) heavily; the old logic mis-
 *   flagged those, but those are "the name of the key," not "the key
 *   itself". See openspec/changes/v1.19.13-secret-detect-keyword-tighten/
 *   proposal.md.
 *
 *   Also: when detected=true, the response now includes a matched_text
 *   field (truncated to 80 chars) so callers can tell the AI which segment
 *   triggered the block in the 400 response — the AI gets it right on the
 *   first try instead of guessing across multiple retries.
 *
 * Note: `reason` strings inside the detector return values are kept in
 * Chinese on purpose — they are surfaced to the AI to instruct it to
 * rewrite memory content in Chinese, and tests assert on the Chinese
 * substring `'賦值樣式'`. A separate Track A pass would coordinate the
 * translation alongside test updates.
 *
 * @param {string|*} value - the content to inspect (typically memory.content)
 * @param {Object} [options]
 * @param {string} [options.title] - title of the corresponding memory
 *   (used by keyword detection)
 * @param {string} [options.description] - description / metadata comment
 * @param {boolean} [options.allow_bypass] - explicit opt-in to skip
 *   detection (callers must have written an audit log)
 * @param {boolean} [options.skip_keyword] - skip keyword detection
 *   (narrative-type usage). Regex and length heuristic still run, so a
 *   real key pasted in won't slip through; only the keyword pass
 *   (title/description/content containing password/token/密碼...) is
 *   suppressed, to avoid flagging narrative memories (iron_rule,
 *   principle) that discuss password topics.
 * @returns {{ detected: boolean, rule?: string, reason?: string, matched_text?: string }}
 *   - detected: whether something matched
 *   - rule: detector tag (regex:xxx / keyword:xxx / heuristic:xxx)
 *   - reason: human-readable explanation (Chinese, see note above)
 *   - matched_text: triggering fragment (≤ 80 chars, since v1.19.13)
 */
export function detectSecretLike(value, options = {}) {
  // 1. Bypass: explicit opt-in skips everything.
  if (options && options.allow_bypass === true) {
    return { detected: false };
  }

  // 2. Edge inputs: null / undefined / non-string → no throw, return false.
  if (typeof value !== 'string' || value.length === 0) {
    return { detected: false };
  }

  const title = (options && typeof options.title === 'string') ? options.title : '';
  const description =
    options && typeof options.description === 'string' ? options.description : '';

  // 3. Regex detection (most precise, runs first).
  for (const { name, pattern } of SECRET_REGEXES) {
    const m = value.match(pattern);
    if (m) {
      return {
        detected: true,
        rule: `regex:${name}`,
        reason: `value 符合 ${name} 格式`,
        matched_text: truncateMatch(m[0]),
      };
    }
  }

  // 4. Keyword detection (title + description contain sensitive keywords).
  //    skip_keyword=true bypasses this for narrative types
  //    (iron_rule / principle etc., which legitimately discuss password
  //    topics and shouldn't be wrongly flagged; regex and length
  //    heuristic still run).
  if (!options.skip_keyword) {
    const haystack = `${title} ${description}`.toLowerCase();
    const haystackOriginal = `${title} ${description}`; // CJK is not lowercased
    for (const keyword of SECRET_KEYWORDS_EN) {
      if (haystack.includes(keyword)) {
        return {
          detected: true,
          rule: `keyword:${keyword}`,
          reason: `title／description 含關鍵字「${keyword}」`,
          // v1.19.13 review I-1: do not echo surrounding context; avoid
          // bringing adjacent PII in the title (phone / email) into the
          // 400 body / log. Only return the literal keyword.
          matched_text: keyword,
        };
      }
    }
    for (const keyword of SECRET_KEYWORDS_CJK) {
      if (haystackOriginal.includes(keyword)) {
        return {
          detected: true,
          rule: `keyword:${keyword}`,
          reason: `title／description 含關鍵字「${keyword}」`,
          matched_text: keyword,
        };
      }
    }

    // v1.19.13: value-side keyword detection requires an assignment shape
    // (KEY: VALUE or KEY=VALUE).
    //   The old "value.includes(keyword) → block" misfired on:
    //     - secret-name references like "anydesk.bot_kkvin.unattended_password"
    //     - generic prose like "the password is in the vault"
    //   New logic demands keyword followed by :/= separator + ≥8-char
    //   "value-looking" string, separating "discussing passwords" from
    //   "pasting an actual password".
    //   See openspec/changes/v1.19.13-secret-detect-keyword-tighten/spec.md S1.
    const am = value.match(KEYWORD_ASSIGNMENT_REGEX);
    if (am) {
      const keyword = normalizeKeywordRuleName(am[1]);
      return {
        detected: true,
        rule: `keyword:${keyword}`,
        reason: `value 含 ${am[1]} 賦值樣式（值長度 ${am[2].length}）`,
        matched_text: truncateMatch(am[0]),
      };
    }
  }

  // 5. Length heuristic (last-resort safety net).
  //    Pure alphanumerics (plus -, _, +, /, =) ≥ 20 chars and no CJK → match.
  //    v1.19.13: dot-separated identifier paths (e.g.
  //    anydesk.bot_kkvin.unattended_password, process.env.MY_PASSWORD)
  //    are not "key/token-shaped" and skip this heuristic.
  //    Real keys (JWT, AWS, GitHub PAT, OpenAI) have dedicated regexes;
  //    we don't rely on the heuristic for them.
  if (
    value.length >= 20 &&
    !CJK_REGEX.test(value) &&
    LONG_ALNUM_REGEX.test(value) &&
    !DOT_SEPARATED_IDENTIFIER_REGEX.test(value)
  ) {
    return {
      detected: true,
      rule: 'heuristic:long_alnum',
      reason: 'value 為 ≥20 字純英數字、看起來像 key / token',
      matched_text: truncateMatch(value),
    };
  }

  return { detected: false };
}

/**
 * v1.19.13: truncate a matched fragment to ≤ 80 chars so we never echo a
 * real key in full into console / log output.
 */
function truncateMatch(text) {
  if (typeof text !== 'string') return '';
  return text.length > 80 ? text.slice(0, 80) : text;
}

/**
 * v1.19.13: turn the matched keyword literal (which may include -, _, or
 * whitespace) into a rule name.
 * Examples: 'API_KEY' → 'api_key'; 'API KEY' → 'api_key'; 'Api-Key' → 'api_key'.
 */
function normalizeKeywordRuleName(raw) {
  return raw.toLowerCase().replace(/[-\s]/g, '_');
}

/**
 * Known secret-format regexes. A match is treated as sensitive.
 *
 * Design: regexes are NOT anchored with ^/$ — we need to catch keys
 * embedded within narrative text (e.g. an iron_rule that pasted a real
 * token as an example).
 * To curb false positives, each regex is tightly bounded on length and
 * character class.
 */
const SECRET_REGEXES = [
  // WordPress Application Password: 4 chars per group, exactly 6 groups,
  // whitespace separated.
  // Example: iXEN ops5 pJcy 8PJI lVFM heaH
  // Uses {5} (exactly 5 separators = 6 groups) instead of {5,} to avoid
  // matching ordinary English prose.
  {
    name: 'wp_application_password',
    pattern: /\b[A-Za-z0-9]{4}(?:\s[A-Za-z0-9]{4}){5}\b/,
  },
  // JWT: header.payload.signature, three base64url segments.
  // Each segment ≥10 chars to reduce false positives.
  {
    name: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  // GitHub PAT: ghp_ / ghs_ / gho_ / ghu_ prefix + 36+ chars.
  {
    name: 'github_pat',
    pattern: /gh[opsu]_[A-Za-z0-9]{36,}/,
  },
  // AWS Access Key ID: AKIA + 16 uppercase alphanumerics.
  // Uses (?![A-Z0-9]) to ensure nothing follows (avoids matching AKIA + 17+
  // accidental chars).
  {
    name: 'aws_access_key',
    pattern: /AKIA[A-Z0-9]{16}(?![A-Z0-9])/,
  },
  // OpenAI API key: sk- prefix + 20+ chars (alnum / hyphen / underscore).
  {
    name: 'openai_api_key',
    pattern: /sk-[A-Za-z0-9_-]{20,}/,
  },
  // v1.19.10: OwnMind pre-defined key prefixes.
  // Tied to the 2026-05-22 incident where 'vin-ownmind-admin-2026' and
  // similar literal keys were committed to a public repo.
  {
    name: 'ownmind_predefined_key',
    pattern: /\b(?:vin-)?ownmind-(?:admin|super|user|api)-[A-Za-z0-9-]{2,}\b/i,
  },
  // v1.19.10: default-password literal pattern (Password + 8+ digits).
  // Tied to the 2026-05-22 incident with 'Password42760988'-style
  // default templates.
  {
    name: 'default_password_literal',
    pattern: /\bPassword\d{8,}\b/,
  },
];

/**
 * English sensitive keywords (case-insensitive match).
 */
const SECRET_KEYWORDS_EN = [
  'password',
  'passwd',
  'token',
  'api_key',
  'api-key',
  'api key',
  'apikey',
  'secret',
  'credential',
  'bearer',
];

/**
 * Chinese sensitive keywords (matched in original case — not lowercased).
 */
const SECRET_KEYWORDS_CJK = [
  '應用程式密碼',
  '存取金鑰',
  '客戶端密鑰',
  '密碼',
  '密鑰',
  '金鑰',
];

/**
 * v1.19.13: value-side keyword assignment-shape detection.
 *
 * Match conditions (all required):
 *   1. Word-boundary-prefixed keyword (password / passwd / token / api_key
 *      / apikey / secret / credential / bearer).
 *   2. Followed by :, =, or => separator (whitespace allowed around).
 *   3. Followed by a "value-looking" string: optionally quoted, ≥8
 *      non-whitespace non-quote characters.
 *
 * Non-matches (false-positive forms we want to drop):
 *   - 'anydesk.bot_kkvin.unattended_password' has no :/= suffix.
 *   - 'the password is in the vault' has no :/=.
 *   - 'password: hi' value length < 8 (avoids form-label false positives).
 *   - 'mypassword=xxx' the leading 'm' breaks the word boundary
 *     (compound word).
 *
 * Note: unicode flag 'u' makes \b handle CJK boundaries correctly.
 */
const KEYWORD_ASSIGNMENT_REGEX =
  /(?<![A-Za-z])(password|passwd|token|api[_\- ]?key|apikey|secret|credential|bearer)\s*(?:=>|[:=])\s*["']?([^\s"'`,;]{8,200})["']?/i;
// (?<![A-Za-z]) (instead of \b) avoids treating 'mypassword=' as a standalone
// keyword while still allowing 'API_TOKEN=' (the underscore-separated common
// env-var form). Underscore is not a letter, so the lookbehind doesn't block.
//
// review I-3 spelled out: this lookbehind is intentionally asymmetric; it
// continues to match assignment-shape prefixes like '_password=',
// 'foo_password=', '-token=', '123token=' (typically snake_case / kebab-case
// env-var names such as reset_password_token=abc12345). Only letter-prefixed
// compounds like 'mypassword=' / 'mytoken=' are treated as non-secrets.
//
// review I-5 upper bound: value length capped at 200 to avoid pathological
// 1MB inputs dragging the regex engine.

/**
 * v1.19.13: dot-separated identifier path.
 *
 * Strings shaped like 'foo.bar.baz_qux' / 'process.env.MY_KEY' are treated
 * as "named references to a resource / key," not the key itself.
 *
 * Rules:
 *   - Each segment is a valid identifier (letter / underscore start,
 *     followed by letters / digits / underscores).
 *   - At least **two** `.` separators (i.e. ≥ 3 segments).
 *
 * review I-2: requires ≥ 3 segments and does NOT accept 2-segment forms.
 * Reason: a JWT with its signature chopped off (`eyJhbGc...eyJzdW...`) is
 * exactly a 2-segment form made of letters/digits and would be treated as
 * an identifier path and skipped. Real key-name references
 * (`anydesk.bot_kkvin.unattended_password`, `process.env.MY_PASSWORD`)
 * have 3+ segments and aren't affected. 2-segment shapes like
 * `lodash.merge` / `package.json` are typically < 20 chars and don't reach
 * the length heuristic.
 *
 * Used as a negative condition for the length heuristic (a match means
 * "let it through, not a secret").
 */
const DOT_SEPARATED_IDENTIFIER_REGEX =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){2,}$/;

/**
 * Pure alphanumerics plus a few symbols (used by the length heuristic).
 * Includes: A-Z a-z 0-9 - _ + / = .
 *
 * Does NOT include whitespace — code-review I-1 fix: the original included
 * \s, which mis-flagged plain English notes like "Working on JWT
 * integration today" as secrets (length ≥ 20 with letters + whitespace).
 * Real key formats are single tokens with no whitespace (JWT / GitHub PAT /
 * AWS / OpenAI); the WP password uses its dedicated regex; the heuristic
 * does not need whitespace support.
 */
const LONG_ALNUM_REGEX = /^[A-Za-z0-9\-_+/=.]+$/;

/**
 * CJK Unicode ranges (Chinese / Japanese / Korean unified ideographs).
 * Presence implies natural-language text, not a key.
 */
const CJK_REGEX = /[　-〿぀-ゟ゠-ヿ一-鿿＀-ﾟ]/;
