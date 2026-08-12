import https from 'https';
import http from 'http';
import { ruleMatchesTrigger } from '../../shared/helpers.js';
import { HOOK_CONTEXT_TYPES } from '../../shared/hook-context.js';

/**
 * Fetch the per-category rule counts a reminder needs, in one request.
 *
 * issue #94 — `/api/memory/hook-context` is new in v1.26.151. The hooks and the server are
 * updated separately and often are not the same version: a hook that only knew the new
 * endpoint would go silent against a server that has not been deployed yet, and silence is
 * indistinguishable from "no rules apply" — the failure mode this project keeps having to
 * design against. So an unrecognised endpoint falls back to `/type/iron_rule`, the shape
 * every server since v1.19 answers, and the reminder degrades to what it printed before
 * rather than to nothing.
 *
 * The fallback filters client-side because that is what the old endpoint requires: it returns
 * every iron rule and leaves the matching to the caller.
 */

function httpGetWithStatus(url, headers, timeout) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, timeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** An all-zero count map, so callers never have to guard on a missing category. */
export function emptyCounts() {
  const counts = {};
  for (const { type } of HOOK_CONTEXT_TYPES) counts[type] = 0;
  return counts;
}

/**
 * @param {object} opts
 * @param {string} opts.apiUrl
 * @param {string} opts.apiKey
 * @param {string} opts.trigger
 * @param {number} [opts.timeout] — per-request ceiling in ms
 * @returns {Promise<{counts: Record<string, number>, rules: Array<{code?: string, title: string}>, legacy: boolean}>}
 * @throws when the server cannot be reached at all — callers decide whether that is fatal
 */
export async function fetchHookContext({ apiUrl, apiKey, trigger, timeout = 3000 }) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const url = `${apiUrl}/api/memory/hook-context?trigger=${encodeURIComponent(trigger)}`;
  const res = await httpGetWithStatus(url, headers, timeout);

  if (res.status === 200) {
    const parsed = JSON.parse(res.body);
    const data = parsed?.data || parsed;
    if (data && data.counts) {
      return { counts: { ...emptyCounts(), ...data.counts }, rules: data.rules || [], legacy: false };
    }
    // A 200 whose body is not the shape this endpoint documents. Treat it as a server that
    // does not have it rather than trusting a half-understood payload.
  }

  // Anything else — 404 from an older server, a proxy's 502, a body we cannot read — is
  // answered by the endpoint that has existed all along.
  const legacyRes = await httpGetWithStatus(`${apiUrl}/api/memory/type/iron_rule`, headers, timeout);
  if (legacyRes.status !== 200) throw new Error(`iron_rule lookup returned ${legacyRes.status}`);
  const parsed = JSON.parse(legacyRes.body);
  const all = Array.isArray(parsed) ? parsed : (parsed.data || []);
  const rules = all.filter((r) => ruleMatchesTrigger(r, trigger));
  // Only the iron-rule count is knowable here. The other four stay 0 and the caller is told
  // this is the legacy shape, so it can print the old line instead of four honest-looking
  // zeroes that actually mean "not asked".
  return { counts: { ...emptyCounts(), iron_rule: rules.length }, rules, legacy: true };
}
