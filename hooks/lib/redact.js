/**
 * Strip credential-shaped text before anything leaves the machine, or lands on disk.
 *
 * The reply and the recent prompts go to the user's own server, which decides which rules
 * apply to them. That is a path out for conversation text, and an AI reply quoting a config
 * file or a curl command carries whatever the user was working on — so it goes through the
 * same redaction the session route already applies rather than a second, subtly different one.
 * Two sanitisers is how one of them ends up weaker than the other.
 *
 * WHY IT LIVES HERE. It used to be a function inside hooks/lib/compliance-client.js, which
 * was the only thing that sent conversation text to the server. When the judge moved onto the
 * user's own machine that file became unreachable and was deleted — and the redaction went
 * with it, silently, because the new sender was written from scratch and nothing named this
 * as a control it had to keep. Review caught it before release. Its own module now, so the
 * next thing that sends text out has something to import rather than something to reinvent.
 *
 * WHAT IT COVERS (v1.30.49). It used to know two shapes: `keyword=value` with nothing between
 * the keyword and the separator, and `Bearer x`. The security review of 2026-10-03 (item 9)
 * measured what that let through: a JSON config (`"api_key": "…"` — the closing quote sits
 * between keyword and colon), a quoted value with a space in it (only the first word went), a
 * bare GitHub / OpenAI / Anthropic / AWS key with no keyword in front of it, a private key
 * block, a password inside a URL, `Authorization: Basic`, `--token x`, `密碼：x` — and the
 * user's own OwnMind key, which is a plain UUID and matches none of the above. Now:
 *
 *   1. the caller's own known secrets, matched literally (the OwnMind key the hook holds);
 *   2. private key blocks;
 *   3. every key format shared/secret-detect.js blocks at the memory write boundary — the
 *      same list, imported, so the two cannot drift — plus formats that only matter here;
 *   4. passwords in URLs, `Authorization:` headers of any scheme, `Bearer x` anywhere;
 *   5. keyword assignments in env, YAML, JSON, CLI-flag and Chinese form.
 *
 * It errs towards blanking: a few characters of a judged reply lost to `[REDACTED]` cost the
 * judge nothing, a key sent to a server costs the user the key.
 */

import { SECRET_REGEXES } from '../../shared/secret-detect.js';

/** Enough of a surprise to diagnose it, not enough for one to land on disk wholesale. */
export const MAX_REASON_CHARS = 200;

const MASK = '[REDACTED]';

/**
 * Looser variants of formats secret-detect.js carries, kept out of there because a looser rule
 * would block memory writes and commits, while here it only costs a few characters of a reply.
 * (GitLab, Slack, Google, Stripe and friends moved into secret-detect.js in v1.30.50.)
 */
const EXTRA_FORMATS = [
  /gh[opsur]_[A-Za-z0-9]{30,}/g,                 // GitHub classic, a little shorter than detect's floor
  /\bnpm_[A-Za-z0-9]{36}\b/g,                    // npm
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g,    // AWS access key id, temporary ones included
];

/** secret-detect.js's list, global, with each rule's `confirm` kept so prose still passes. */
const SHARED_FORMATS = SECRET_REGEXES.map(({ pattern, confirm }) => ({
  pattern: new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
  confirm,
}));

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

/** Webhook URLs are the credential themselves; the host stays so the reader knows what it was. */
const WEBHOOK_URLS = [
  /(hooks\.slack\.com\/services\/)[^\s"'`<>)]+/gi,
  /(discord(?:app)?\.com\/api\/webhooks\/)[^\s"'`<>)]+/gi,
];

/**
 * `scheme://user:password@host` — the user name stays, it says whose account it was, and may
 * be empty (`redis://:pw@host`).
 *
 * PERFORMANCE. The scheme is bounded and may not start in the middle of a scheme-shaped run.
 * With `\b` and an unbounded scheme, every `.` or `-` in a long run was a fresh start that
 * scanned to the end of the run: 200KB of base64 took 2.5 seconds, `a.a.a…` 18 seconds — and
 * this runs synchronously in the Stop hook.
 */
const URL_CREDENTIAL = /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{0,100}):[^\s@/]+@/gi;

/** `curl -u user:password`, `--user user:password`. */
const CURL_USER = /((?:^|\s)(?:-u\s*|--user[\s=]+)["']?[^\s:"']{1,100}:)[^\s"']+/g;

/**
 * `Bearer x` anywhere, as before, but the value has to look like a token — "the bearer of bad
 * news" is not one. Basic and Token are English words, so only after the header name.
 */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const AUTH_HEADER = /\b((?:Proxy-)?Authorization\\?["']?\s*[:=]\s*\\?["']?)(?:(?:Digest|AWS4-HMAC-SHA256)\s+[^\n]+|(?:Basic|Bearer|Token|Negotiate|NTLM)\s+[^\s"'`]+|[A-Za-z0-9._~+/=-]{16,})/gi;
/** Cookies are sessions; the whole header value goes. */
const COOKIE_HEADER = /\b((?:Set-)?Cookie\s*:\s*)[^"'`\n]+/gi;

/** `<password>x</password>`, `<ApiKey>x</ApiKey>` in XML and .config files. */
const XML_ELEMENT = /(<([\w:.-]{0,40}(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|account[_-]?key)[\w:.-]{0,40})>)[^<]*(<\/\2>)/gi;

/**
 * The keyword, up to 40 word characters that follow it (`api_key_v2`, `secret_access_key`;
 * `OWNMIND_API_KEY` matches on its `API_KEY`), an optional closing quote — escaped too, since
 * logs and `JSON.stringify` output carry `\"api_key\": \"…\"` — then the separator.
 *
 * The 40 is a performance bound, not a style choice: unbounded, every keyword in a long word
 * run scanned to its end and gave up there, which is quadratic.
 */
const KEYWORDS = String.raw`(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key|credential|auth[_-]?key|session[_-]?key|ownmind[_-]?key)`;
const CJK_KEYWORDS = String.raw`(?:密碼|密鑰|金鑰|口令)`;
const SEPARATOR = String.raw`(?:=>|[:=：](?!=))`;
/**
 * A quoted value goes whole. An unquoted one stops at whitespace, `,`, `;`, and anything CJK —
 * Chinese has no spaces, so without that last stop `金鑰：已經換好了，設定檔我也確認過…` lost the
 * whole sentence, which is exactly the sentence a judge needs for a rule about keys. A value
 * that STARTS with CJK is prose about a password, not one, and is left alone.
 */
const VALUE = String.raw`(?:\\"(?:[^"\\\n]|\\[^"])*\\"|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|` + '`[^`\\n]*`' +
  String.raw`|[^\s,;"'` + '`' + String.raw`，。；、：　-〿一-鿿＀-￯]+)`;
const KEYWORD_ASSIGNMENT = new RegExp(
  String.raw`(${KEYWORDS}[\w-]{0,40}\\?["']?\s*${SEPARATOR}\s*)${VALUE}`,
  'gi',
);
/** `密碼：x`, `密碼是 x`, `密碼為 x`. The value still has to be token-shaped (see VALUE). */
const CJK_ASSIGNMENT = new RegExp(
  String.raw`(${CJK_KEYWORDS}(?:(?:是|為|为)\s*${SEPARATOR}?|\s*${SEPARATOR})\s*)${VALUE}`,
  'g',
);
/** `--password hunter2`, `--api-key=x`. The `=` form is covered above too; harmless twice. */
const CLI_FLAG = new RegExp(String.raw`(--${KEYWORDS}[\w-]{0,40}(?:\s+|=))(?!-)${VALUE}`, 'gi');

function maskFormat(text, { pattern, confirm }) {
  return text.replace(pattern, (match) => (confirm && !confirm(match) ? match : MASK));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} text
 * @param {{ secrets?: Array<string|null|undefined> }} [options]
 *   secrets: values the caller holds and knows are secret, masked wherever they appear. Shorter
 *   than 8 characters is ignored — masking every `abc` in a reply is not protecting anything.
 */
export function redact(text, { secrets = [] } = {}) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;

  for (const s of secrets) {
    if (typeof s === 'string' && s.trim().length >= 8) {
      out = out.replace(new RegExp(escapeRegExp(s.trim()), 'g'), MASK);
    }
  }

  out = out.replace(PRIVATE_KEY_BLOCK, '[REDACTED PRIVATE KEY]');
  for (const format of SHARED_FORMATS) out = maskFormat(out, format);
  for (const pattern of EXTRA_FORMATS) out = out.replace(pattern, MASK);
  for (const pattern of WEBHOOK_URLS) out = out.replace(pattern, `$1${MASK}`);

  return out
    .replace(URL_CREDENTIAL, `$1:${MASK}@`)
    .replace(CURL_USER, `$1${MASK}`)
    .replace(COOKIE_HEADER, `$1${MASK}`)
    .replace(XML_ELEMENT, `$1${MASK}$3`)
    .replace(AUTH_HEADER, (match, head) => `${head}${MASK}`)
    .replace(BEARER, `Bearer ${MASK}`)
    .replace(KEYWORD_ASSIGNMENT, (match, head) => `${head}${MASK}`)
    .replace(CJK_ASSIGNMENT, (match, head) => `${head}${MASK}`)
    .replace(CLI_FLAG, (match, head) => `${head}${MASK}`);
}

/**
 * A failure reason, safe to keep for weeks.
 *
 * These end up in ~/.ownmind/logs/check-failures.jsonl. A proxy answering HTML to a request
 * expecting JSON puts the first characters of that HTML into the parser's error message, so
 * the cap bounds what a surprise can write, and the redaction covers the case where what came
 * back quotes the request that produced it.
 */
export function toReason(text) {
  return redact(String(text ?? 'error')).slice(0, MAX_REASON_CHARS);
}
