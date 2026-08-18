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
 *   anydesk.bot_example.unattended_password) heavily; the old logic mis-
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
  for (const { name, pattern, confirm } of SECRET_REGEXES) {
    const hit = confirm ? findConfirmedMatch(value, pattern, confirm) : value.match(pattern)?.[0];
    if (hit !== undefined && hit !== null) {
      return {
        detected: true,
        rule: `regex:${name}`,
        reason: `value 符合 ${name} 格式`,
        matched_text: truncateMatch(hit),
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
    //     - secret-name references like "anydesk.bot_example.unattended_password"
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
  //    ≥20 chars, no CJK, drawn from the key charset, and with no word structure.
  //    Real keys (JWT, AWS key id, GitHub PAT, OpenAI) have dedicated regexes and are
  //    matched above; this catches the formats that do not.
  //
  //    v1.19.13 exempted dot-separated identifier paths and v1.26.8 exempted slash-separated
  //    file paths, each after a legitimate commit was blocked. v1.26.98 replaced both with a
  //    measurement of word structure, which answers the same question without needing a new
  //    exemption per shape — the rate of wrongly-blocked tokens in this repository's own
  //    source went from one in three to under one in a hundred.
  if (
    value.length >= 20 &&
    !CJK_REGEX.test(value) &&
    LONG_ALNUM_REGEX.test(value) &&
    !PUNCTUATION_ONLY_REGEX.test(value) &&
    // v1.26.98: length and charset alone do not tell a key from an identifier. See
    // wordCoverage above for the measurement that prompted this.
    //
    // This replaces the dot-path and slash-path exemptions rather than joining them. Both
    // existed to answer the same question — "is this an identifier rather than a key?" — by
    // listing shapes an identifier takes, and each was added after a commit was wrongly
    // blocked. Measuring word structure answers it directly, and the two regexes were also
    // exempting things that are not paths at all: any value with three or more
    // slash-separated chunks was waved through, which is a shape a base64 secret can take.
    wordCoverage(value) < WORD_COVERAGE_LIMIT
  ) {
    return {
      detected: true,
      rule: 'heuristic:long_alnum',
      reason: 'value 為 ≥20 字、沒有單字結構，看起來像 key / token',
      matched_text: truncateMatch(value),
    };
  }

  return { detected: false };
}

/**
 * Does this 4-character alphanumeric group look like a plain word rather than
 * part of a random string?
 *
 * Contract: callers pass one group of the WP password shape, i.e. exactly four
 * ASCII alphanumerics. True for the three ways prose writes a word — all lower
 * case, all upper case, or an initial capital. A digit anywhere means no, since
 * words do not carry them.
 *
 * Every input outside that contract (empty string, punctuation, non-ASCII
 * letters) answers false, which makes the caller treat the group as
 * non-word-shaped and keep the match. That direction fails safe for a secret
 * scanner, but a future caller should not read this as a general-purpose
 * "is this a word" test.
 *
 * @param {string} token exactly four ASCII alphanumerics
 * @returns {boolean}
 */
function looksLikePlainWord(token) {
  if (/[0-9]/.test(token)) return false;
  return /^[a-z]+$/.test(token) || /^[A-Z]+$/.test(token) || /^[A-Z][a-z]+$/.test(token);
}

/**
 * Return the first match a rule's `confirm` predicate accepts, or null.
 *
 * Two things matter here, both about not trading a false positive for a false
 * negative:
 *
 * 1. Every match is considered, not just the first. A file can hold prose that
 *    fits the shape before the credential it also contains.
 * 2. After a rejected match the scan resumes one character past its **start**,
 *    not past its end. `matchAll` (and a bare `exec` loop) advances to the end,
 *    which carves a contiguous run of four-character tokens into fixed
 *    six-token windows and never looks at the ones that straddle a boundary.
 *    With five prose words in front of a credential, window one is those five
 *    plus the credential's first group; skipping to its end hides the whole
 *    credential whenever that first group happens to be word-shaped — measured
 *    at 8.98% of draws. Overlapping the scan removes that entirely.
 *
 * The `\b` anchor keeps candidate start positions at token boundaries, so the
 * overlapping scan stays linear in practice.
 *
 * @param {string} value
 * @param {RegExp} pattern
 * @param {(match: string) => boolean} confirm
 * @returns {string|null}
 */
function findConfirmedMatch(value, pattern, confirm) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const scanner = new RegExp(pattern.source, flags);
  let m;
  while ((m = scanner.exec(value)) !== null) {
    if (confirm(m[0])) return m[0];
    // +1 rather than the match end: overlap-safe, and it also guarantees
    // progress if a pattern ever matches the empty string.
    scanner.lastIndex = m.index + 1;
  }
  return null;
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
  // Shape: six space-separated groups of four alphanumerics. No literal example
  // here on purpose — this repository ships the detector, and a real-looking
  // sample in its own source blocks the pre-commit scan that uses it.
  //
  // This is the only rule here with no identifying prefix (jwt has `eyJ`,
  // github_pat has `gh?_`, aws has `AKIA`, openai has `sk-`), so shape alone
  // has to carry it — and English produces this shape readily, because
  // four-letter words are common. "hope that this vlog will help" fits it
  // exactly, which blocked a legitimate commit (bug report #8). An earlier
  // attempt tightened {5,} to {5}; that constrained how many groups match, not
  // what they are made of, so prose kept matching.
  //
  // WordPress generates these with wp_generate_password(24, false): 24
  // characters drawn at random from upper case, lower case, and digits. Such a
  // draw essentially never produces six groups that all look like plain words,
  // while prose groups always do — so `confirm` requires at least one group
  // that does not.
  //
  // Residual miss rate, since "essentially never" is not never: per group
  // P(word-shaped) = 3·(26/62)^4 = 0.0928, so all six is 6.378e-7, about 1 in
  // 1.57 million. `Abcd efgh Ijkl mnop QRST uvwx` is such a draw and is missed.
  // Accepted deliberately — the next-best candidate ("contains a digit") missed
  // 1.5%. A per-group entropy floor would close the gap if this ever matters.
  {
    name: 'wp_application_password',
    pattern: /\b[A-Za-z0-9]{4}(?:\s[A-Za-z0-9]{4}){5}\b/,
    confirm: (match) => match.split(/\s+/).some((group) => !looksLikePlainWord(group)),
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
  // v1.26.125 — Anthropic keys are `sk-ant-…`, and this rule exists so they stop being
  // reported as OpenAI's.
  //
  // Both vendors use an `sk-` prefix, and a single rule named `openai_api_key` owned the
  // whole family. Blocking was always correct; the *diagnosis* was not. Measured during the
  // v1.26.124 release, when the new baseline scan blocked that release's own commit:
  //
  //     leak.txt: value 符合 openai_api_key 格式 (detected_by=regex:openai_api_key)
  //               matched="sk-ant-a…AAAA"
  //
  // The masked fragment says `sk-ant-` while the rule name says OpenAI, so a user who has
  // never held an OpenAI key is sent to look for one. Same class as v1.26.28, which added
  // `matched_text` because a hidden match got bug id=6 misdiagnosed: the block is only half
  // the job, and a wrong name costs the other half.
  //
  // Listed before the OpenAI rule because the loop above returns on first match, and the
  // OpenAI pattern additionally refuses `ant-` so the two do not depend on this order.
  // Either alone would work; the pair means neither a reorder nor an edit to one pattern
  // can quietly hand Anthropic keys back to the wrong vendor.
  {
    name: 'anthropic_api_key',
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/,
  },
  // OpenAI API key: sk- prefix + 20+ chars (alnum / hyphen / underscore).
  // The `(?!ant-)` excludes Anthropic's prefix only — four literal characters including the
  // hyphen — so `sk-antelope…` is still read as OpenAI, as it should be.
  {
    name: 'openai_api_key',
    pattern: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/,
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
 *   - 'anydesk.bot_example.unattended_password' has no :/= suffix.
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
 * v1.26.98 — the dot-path and slash-path exemptions used to live here.
 *
 * Both existed to answer "is this an identifier rather than a key?" by listing the shapes an
 * identifier takes, and each was added after a legitimate commit was blocked. `wordCoverage`
 * answers the same question by measuring the value instead, so neither is needed: removing
 * them moved the false-positive count on this repository's own tokens by 9 out of 10491.
 *
 * They were also unsound in one direction. `SLASH_SEPARATED_PATH_REGEX` waved through any
 * value with three or more slash-separated chunks, and a base64 secret can take that shape.
 */


/**
 * v1.26.28 — punctuation-only separator lines (e.g. 66 dashes as a horizontal
 * rule, `====` markdown heading underlines, `-=-=-=` banners).
 *
 * Used as a negative condition for the length heuristic. A value composed
 * entirely of the heuristic charset's symbols (- _ + / = .) with zero
 * alphanumeric characters has nothing key-like about it: JWT / AWS / GitHub
 * PAT / OpenAI keys are all alnum-dominant single tokens. Report .md and .py
 * files routinely emit such separator lines at column 0, which previously
 * tripped heuristic:long_alnum and blocked legitimate commits (bug-report
 * id=6, 2026-07-07).
 */
const PUNCTUATION_ONLY_REGEX = /^[-_+/=.]+$/;

/**
 * Pure alphanumerics plus a few symbols (used by the length heuristic).
 * Includes: A-Z a-z 0-9 - _ + / = .
 *
 * Keep the symbol subset in lockstep with PUNCTUATION_ONLY_REGEX above —
 * if you add a symbol here, add it there too, or separator lines built
 * from the new symbol will regress into heuristic:long_alnum hits.
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
 * v1.26.98 — does this value read as words rather than as a random string?
 *
 * The length heuristic keyed on length and character set alone, which does not distinguish
 * a key from an identifier: `REASON_MAX_CHARS=300` and `.update-lock.reclaim` were both
 * blocked as suspected credentials on 2026-08-07, and measuring it against every ≥20-char
 * token in this repository's own tracked files put the false-positive rate at
 * **3438 of 10486 (33%)**. Three exemptions had already been bolted on (dot paths, slash
 * paths, separator lines) and a fourth was the wrong answer: the rule was measuring the
 * wrong property.
 *
 * What actually separates the two is randomness. A key has no word structure; an identifier
 * is words joined by `-`, `_`, `.` or camelCase. So:
 *
 *   1. Take the longest unbroken run of key-shaped characters. `- _ .` break a run, because
 *      that is how identifiers and file paths are built; `/ + =` do not, because they are
 *      part of the base64 alphabet real keys use. (An AWS secret access key is exactly this
 *      case, and was not being caught at all before.)
 *   2. Split that run on camelCase boundaries and ask how much of it is covered by
 *      word-shaped segments: three or more letters, containing a vowel, no digits.
 *   3. Mostly words → an identifier. Otherwise → key-shaped.
 *
 * Short segments like `To`, `Id`, `At` are not word-shaped on their own, which is why this
 * is a coverage ratio rather than a rule about every segment: `renderToPipeableStream` is
 * 91% covered and passes, while `AbCdEfGhIjKlMnOpQrStUvWx` — all two-letter segments, half
 * of them vowel-less — is 0% and is caught.
 *
 * This is a filter on the last-resort net only. Every key format with a dedicated regex
 * (JWT, AWS key id, GitHub PAT, OpenAI) is matched earlier and never reaches it.
 */
const KEY_SHAPED_RUN_REGEX = /[A-Za-z0-9/+=]+/g;
const VOWEL_REGEX = /[aeiouAEIOU]/;

/** Fraction of the longest key-shaped run that is covered by word-shaped segments. */
function wordCoverage(value) {
  const runs = value.match(KEY_SHAPED_RUN_REGEX) || [];
  const run = runs.reduce((longest, r) => (r.length > longest.length ? r : longest), '');
  if (run.length < MIN_KEY_RUN_LENGTH) return 1;   // too short to be a key: treat as words
  // Split on camelCase and on the base64 symbols. The symbols stay inside the *run* so that
  // a base64 key is measured as one long token, but they still separate *words*, or a URL
  // path like `api/usage/exemptions` would score zero and be reported as a credential.
  const segments = run
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[/+=]/g, ' ')
    .split(' ');
  const wordChars = segments
    .filter((s) => s.length >= 3 && VOWEL_REGEX.test(s) && !/[0-9/+=]/.test(s))
    .reduce((n, s) => n + s.length, 0);
  return wordChars / run.length;
}

/**
 * A run shorter than this cannot carry enough entropy to be worth guessing about, and every
 * real key format is far longer. Deliberately the same 20 as the length check it sits beside.
 */
const MIN_KEY_RUN_LENGTH = 20;

/**
 * Below this fraction of word-shaped characters, a value is treated as key-shaped.
 *
 * Chosen by measurement, not taste: across 0.5 / 0.6 / 0.7 / 0.8 the false-positive count
 * barely moves (1191 → 1204 on the raw token corpus), while 0.5 loses two real key shapes.
 * 0.6 is the lowest value that keeps all of them.
 */
const WORD_COVERAGE_LIMIT = 0.6;

/**
 * CJK Unicode ranges (Chinese / Japanese / Korean unified ideographs).
 * Presence implies natural-language text, not a key.
 */
const CJK_REGEX = /[　-〿぀-ゟ゠-ヿ一-鿿＀-ﾟ]/;
