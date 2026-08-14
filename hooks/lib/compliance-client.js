import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Client half of the per-turn compliance check.
 *
 * Two rules govern everything here. Never block the user's work when the server is
 * unavailable, and never let that silence look like a clean check: an outcome of 'failed'
 * stays distinct from 'clean' all the way through, and the caller is expected to say so.
 */

// 5 seconds. This sits on the critical path of a checked turn - the user cannot type their
// next prompt until it returns - and the server's own judge budget is 4s, so a healthy check
// finishes well inside this and an unhealthy one is cut off quickly.
const DEFAULT_TIMEOUT_MS = 5_000;
const BACKOFF_MS = 5 * 60 * 1000;

/**
 * A rejected key gets a much shorter one, deliberately.
 *
 * Its notice is the only one that tells the user to go and do something, so five minutes means
 * they do it, are told again, and conclude it did not work. Retrying every single turn instead
 * was the first fix and it was too far the other way: every turn re-POSTs the whole reply for
 * the server to discard, writes an `auth_failed` line, and pays whatever a 401 costs on a
 * struggling server, with no ceiling. A minute keeps all three bounded and is shorter than it
 * takes to re-run the installer, so by the time somebody is back at the keyboard the check has
 * already resumed.
 */
const UNAUTHORIZED_BACKOFF_MS = 60 * 1000;
const STATE_FILE = 'compliance-backoff.json';

function stateFilePath(stateDir) {
  const dir = stateDir || path.join(os.homedir(), '.ownmind', 'state');
  return path.join(dir, STATE_FILE);
}

/**
 * The backoff state carries what failed as well as when to try again.
 *
 * v1.30.2: it used to hold `until_ms` alone, so the short-circuit below could only answer
 * "backing off". A rejected key was therefore identified on the one turn that hit the network
 * and read as a generic outage for the five minutes of turns after it — which are the turns
 * the user actually sees, since the notice throttle speaks on the state change and then every
 * tenth turn.
 */
function readBackoff(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(stateDir), 'utf8'));
    return {
      untilMs: Number.isFinite(parsed?.until_ms) ? parsed.until_ms : 0,
      // An upgrade can land mid-backoff, so absence is normal and must not read as a
      // classification: 'unknown' says "not recorded", where 'network' would be a guess.
      failure: typeof parsed?.failure === 'string' ? parsed.failure : 'unknown',
      reason: typeof parsed?.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return { untilMs: 0, failure: 'unknown', reason: '' };
  }
}

function writeBackoff(stateDir, untilMs, failure, reason) {
  try {
    const file = stateFilePath(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ until_ms: untilMs, failure, reason }), 'utf8');
  } catch { /* a state file we cannot write costs one extra attempt, nothing worse */ }
}

/**
 * Is this the one failure that never heals on its own?
 *
 * 401 only. src/middleware/auth.js answers 401 for a missing or unrecognised key and never
 * 403 on this route — every 403 in the server lives behind the admin routes. So a 403 here
 * came from something in front of the server (a proxy, a WAF, a captive portal), and the
 * notice for `unauthorized` is the only one in the set that gives the user an order. Ordering
 * somebody to sign in again over a corporate proxy is worse than telling them the server
 * could not be reached, which is what actually happened.
 */
function classifyStatus(status) {
  return status === 401 ? 'unauthorized' : 'server';
}

/**
 * Keep a reason short enough that an unexpected response body cannot land on disk wholesale.
 *
 * `redact()` matches credential shapes, not arbitrary text, and a proxy answering HTML to a
 * request expecting JSON puts the first characters of that HTML into the parser's error
 * message. Capping bounds what a surprise can write into a file that is kept for weeks.
 */
const MAX_REASON_CHARS = 200;

function toReason(text) {
  return redact(String(text || 'error')).slice(0, MAX_REASON_CHARS);
}

/**
 * Strip credential-shaped text before anything leaves the machine.
 *
 * The reply and the recent prompts go to the user's own server and on to the configured
 * model endpoint. That is a new path out for conversation text, so it gets the redaction the
 * session route already applies rather than a second, subtly different one - two sanitisers
 * is how one of them ends up weaker than the other.
 */
export function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, (match) => {
      const separator = match.includes('=') ? '=' : ':';
      return `${match.split(/[:=]/)[0]}${separator}[REDACTED]`;
    })
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

/**
 * @returns {Promise<{outcome: string, violations: object[], check_id: number|null,
 *   reason?: string, failure?: 'no-credentials'|'unauthorized'|'server'|'server-declined'
 *   |'timeout'|'network'|'unknown'}>}
 *   `failure` classifies an outcome of 'failed'. `reason` is the detail behind it, in English,
 *   for the local diagnosis log — never for the user, whose notices carry no error text.
 *   'no-credentials' is unreachable through runComplianceStep, which returns its own notice
 *   before calling this; it is here because this function is callable on its own terms.
 */
export async function requestCheck({
  apiUrl, apiKey, payload,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
  stateDir,
}) {
  if (!apiUrl || !apiKey) {
    return {
      outcome: 'failed', violations: [], check_id: null,
      failure: 'no-credentials', reason: 'no credentials',
    };
  }

  // Back off rather than retry on the next turn. An unreachable server would otherwise cost
  // every reply a full timeout for the length of the outage, silently.
  const backoff = readBackoff(stateDir);
  if (now() < backoff.untilMs) {
    return {
      outcome: 'failed',
      violations: [],
      check_id: null,
      failure: backoff.failure,
      reason: backoff.reason
        ? `${backoff.reason} (backing off, not retried this turn)`
        : 'backing off after a failure',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Authorization: Bearer, which is the only scheme src/middleware/auth.js accepts. An
    // earlier draft sent x-api-key; every check would have come back 401 and been filed away
    // as "the server is having problems".
    const response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/api/compliance/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        ...payload,
        assistant_text: redact(payload.assistant_text),
        user_prompts: (payload.user_prompts || []).map(redact),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = classifyStatus(response.status);
      const reason = `http ${response.status}`;
      const wait = failure === 'unauthorized' ? UNAUTHORIZED_BACKOFF_MS : BACKOFF_MS;
      writeBackoff(stateDir, now() + wait, failure, reason);
      return { outcome: 'failed', violations: [], check_id: null, failure, reason };
    }
    const body = await response.json();
    const outcome = body.outcome || 'failed';
    // The server answers 200 with outcome:'failed' for its own four failures — the mode
    // lookup, the rule fetch, the judge call and parsing what the judge said. That is the
    // likeliest failure in production, and without this it landed in the log as
    // "unknown/unknown", which is precisely the state this release exists to remove. Three of
    // the four carry a check_id: the server has a row with the real cause, and this is what
    // lets a local line be joined to it.
    if (outcome === 'failed') {
      // Read against src/routes/compliance.js: none of its four 200-failed returns carries an
      // `error` field, so the reason has to be built from what is actually on the wire. Two
      // things are: `enabled:false` with `outcome:'failed'` is unique to the mode-lookup
      // failing (the DB could not be asked whether this account enforces at all), and a
      // `check_id` means the server got far enough to record its own row, which holds the
      // cause. `body.error` is honoured in case a future server sends one; nothing today does.
      const reason = body.error
        ? toReason(body.error)
        : (body.enabled === false
          ? 'server answered failed with enabled=false (enforcement mode could not be read)'
          : 'server answered failed');
      return {
        outcome,
        violations: [],
        check_id: body.check_id ?? null,
        enabled: body.enabled !== false,
        failure: 'server-declined',
        reason,
      };
    }
    return {
      outcome,
      violations: Array.isArray(body.violations) ? body.violations : [],
      check_id: body.check_id ?? null,
      // v1.26.171: the server sends enabled:false when enforcement is off for the account.
      // Discarding it made "switched off" indistinguishable from "checked and clean".
      enabled: body.enabled !== false,
    };
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    const failure = timedOut ? 'timeout' : 'network';
    // Through the same redactor the outgoing text uses. An error message can quote the request
    // it failed on, and this one is written to a file on disk — a second, subtly weaker
    // sanitiser here is how one of them ends up letting a credential through.
    const reason = timedOut ? 'timeout' : toReason(err?.message);
    writeBackoff(stateDir, now() + BACKOFF_MS, failure, reason);
    return { outcome: 'failed', violations: [], check_id: null, failure, reason };
  } finally {
    clearTimeout(timer);
  }
}
