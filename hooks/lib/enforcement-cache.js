import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The enforcement bundle on disk: selection keys, guard rules, and the text of the rules
 * that get put in front of the AI.
 *
 * Its own file, and that is not a preference. `memories.json` is written from the compact
 * init response, whose documented contract carries no team standards at all, and
 * `holdsInitPayload` in conditional-sync.js actively rejects a payload containing type-keyed
 * arrays. An earlier design had the guard read `memories.json.team_standard`; that key has
 * never existed on any machine, so the guard would have read an empty list forever, blocked
 * nothing, and passed every test that handed it fixtures.
 *
 * There is deliberately no convenience function returning a single list. Three consumers
 * need three different lists, and a helper that quietly returned one of them meant every
 * rule without a path guard - which is most of them, including every rule about how to talk
 * to someone - was dropped before anything looked at it, with nothing reporting a problem.
 */

export const ENFORCEMENT_CACHE_FILE = 'enforcement.json';

/** @returns {string} the default cache location for this machine */
export function defaultCachePath() {
  return path.join(os.homedir(), '.ownmind', 'cache', ENFORCEMENT_CACHE_FILE);
}

function countEntries(bundle) {
  if (!bundle || typeof bundle !== 'object') return 0;
  return ['selectors', 'guards', 'injectables']
    .reduce((n, key) => n + (Array.isArray(bundle[key]) ? bundle[key].length : 0), 0);
}

function isWellFormed(bundle) {
  if (!bundle || typeof bundle !== 'object') return false;
  return ['selectors', 'guards', 'injectables']
    .every((key) => bundle[key] === undefined || Array.isArray(bundle[key]));
}

/**
 * Read the bundle.
 *
 * `present` separates "synced, and this account has nothing annotated" from "never synced".
 * They are different facts: the first is a quiet correct turn, the second means every check
 * on this machine is disabled. A caller that cannot tell them apart will report the second
 * as the first, which is the failure this whole mechanism exists to make impossible.
 *
 * @param {string} [cachePath]
 * @returns {{selectors: object[], guards: object[], injectables: object[], present: boolean}}
 */
export function readEnforcementBundle(cachePath) {
  const file = cachePath || defaultCachePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isWellFormed(parsed)) return { selectors: [], guards: [], injectables: [], present: false };
    return {
      selectors: Array.isArray(parsed.selectors) ? parsed.selectors : [],
      guards: Array.isArray(parsed.guards) ? parsed.guards : [],
      injectables: Array.isArray(parsed.injectables) ? parsed.injectables : [],
      present: true,
    };
  } catch {
    return { selectors: [], guards: [], injectables: [], present: false };
  }
}

/**
 * Whether a freshly fetched bundle is allowed to replace what is already cached.
 *
 * An empty fetch never replaces a populated cache. Emptiness is far more often a broken
 * request than an account that deleted every rule, and a stale cache still enforces
 * something while an empty one enforces nothing. This is the same rule the iron-rule cache
 * applies, for the same reason: one empty response once disarmed every rule at once.
 *
 * @param {object} fetched
 * @param {object|null} existing
 * @returns {boolean}
 */
export function mayReplaceBundle(fetched, existing) {
  if (!isWellFormed(fetched)) return false;
  if (countEntries(fetched) > 0) return true;
  return countEntries(existing) === 0;
}

/**
 * Write the bundle, refusing the writes that would silently disarm the machine.
 *
 * @param {object} bundle
 * @param {string} [cachePath]
 * @returns {boolean} true when the file now holds `bundle`
 */
export function writeEnforcementBundle(bundle, cachePath) {
  const file = cachePath || defaultCachePath();
  if (!isWellFormed(bundle)) return false;

  const existing = readEnforcementBundle(file);
  if (!mayReplaceBundle(bundle, existing.present ? existing : null)) return false;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      selectors: Array.isArray(bundle.selectors) ? bundle.selectors : [],
      guards: Array.isArray(bundle.guards) ? bundle.guards : [],
      injectables: Array.isArray(bundle.injectables) ? bundle.injectables : [],
      saved_at: new Date().toISOString(),
    }, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch the bundle from the server.
 *
 * Returns null on any failure rather than an empty bundle, so a caller cannot mistake an
 * outage for an account with no rules.
 *
 * @param {string} apiUrl
 * @param {string} apiKey
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<object|null>}
 */
export async function fetchEnforcementBundle(apiUrl, apiKey, fetchImpl = fetch) {
  if (!apiUrl || !apiKey) return null;
  try {
    const url = `${apiUrl.replace(/\/+$/, '')}/api/memory/enforcement-bundle`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return isWellFormed(body) ? body : null;
  } catch {
    return null;
  }
}
