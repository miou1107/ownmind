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
const STATE_FILE = 'compliance-backoff.json';

function stateFilePath(stateDir) {
  const dir = stateDir || path.join(os.homedir(), '.ownmind', 'state');
  return path.join(dir, STATE_FILE);
}

function readBackoffUntil(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(stateDir), 'utf8'));
    return Number.isFinite(parsed?.until_ms) ? parsed.until_ms : 0;
  } catch {
    return 0;
  }
}

function writeBackoffUntil(stateDir, untilMs) {
  try {
    const file = stateFilePath(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ until_ms: untilMs }), 'utf8');
  } catch { /* a state file we cannot write costs one extra attempt, nothing worse */ }
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
 * @returns {Promise<{outcome: string, violations: object[], check_id: number|null, reason?: string}>}
 */
export async function requestCheck({
  apiUrl, apiKey, payload,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
  stateDir,
}) {
  if (!apiUrl || !apiKey) {
    return { outcome: 'failed', violations: [], check_id: null, reason: 'no credentials' };
  }

  // Back off rather than retry on the next turn. An unreachable server would otherwise cost
  // every reply a full timeout for the length of the outage, silently.
  if (now() < readBackoffUntil(stateDir)) {
    return { outcome: 'failed', violations: [], check_id: null, reason: 'backing off after a failure' };
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
      writeBackoffUntil(stateDir, now() + BACKOFF_MS);
      return { outcome: 'failed', violations: [], check_id: null, reason: `http ${response.status}` };
    }
    const body = await response.json();
    return {
      outcome: body.outcome || 'failed',
      violations: Array.isArray(body.violations) ? body.violations : [],
      check_id: body.check_id ?? null,
    };
  } catch (err) {
    writeBackoffUntil(stateDir, now() + BACKOFF_MS);
    const reason = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'error');
    return { outcome: 'failed', violations: [], check_id: null, reason };
  } finally {
    clearTimeout(timer);
  }
}
