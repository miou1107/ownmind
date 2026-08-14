import crypto from 'crypto';
import { query as defaultQuery } from './db.js';

/**
 * syncToken.js — short state fingerprints, in two deliberately separate scopes.
 *
 * One hash implementation (`hashScopedState`), one comparison (`compareToken`), two queries.
 * The queries are the whole point: a fingerprint is only as good as the question it answers,
 * and this module was answering two different questions with one set of inputs.
 *
 *   CACHE FRESHNESS  — `generateSyncToken` / `validateSyncToken`
 *     "Has anything the client caches changed?" Its inputs must cover everything a client
 *     stores locally, because the client re-downloads exactly when this value moves.
 *
 *   IRON-RULE LOCK   — `generateIronRuleLockToken` / `validateIronRuleLockToken`
 *     "Did iron-rule state move under this editor?" An optimistic lock. Its inputs must
 *     cover exactly what the editor snapshotted and nothing else, because every unrelated
 *     input is a false conflict thrown at someone mid-edit.
 *
 * Task 5 fix round 2 (gate-message-i18n) split them. Round 1 correctly added the account's
 * locale to the cache-freshness inputs, and — because both callers shared the one function —
 * incorrectly added it to the lock as well: a user switching their own language while an
 * iron-rule upgrade was open got `409 Iron-rule state has changed` with no iron rule changed.
 * Widening one caller's inputs is always the right fix for a stale cache and always the wrong
 * fix for a lock, so they cannot share a definition.
 *
 * Both scopes stay in this file, over one hash and one comparator, so the two can never drift
 * into differently-shaped tokens.
 */

/**
 * The single hash. `scope` is folded in so the two families occupy provably disjoint token
 * spaces: a token from one handed to the other can only fail the comparison, never satisfy it
 * by coincidence.
 *
 * `null` means "no scope prefix" and is used by the cache-freshness token alone. That token's
 * value is on disk on every installed machine (`~/.ownmind/cache/memories.json`), and clients
 * re-download the full init payload the moment it stops matching — so changing its byte layout
 * would bill every account one pointless re-init. Kept byte-identical to what shipped;
 * `tests/sync-token-endpoint.test.js` pins the value.
 *
 * @param {string|null} scope
 * @param {Array<string|number>} parts
 */
function hashScopedState(scope, parts) {
  const raw = (scope === null ? parts : [scope, ...parts])
    .map((p) => (p === undefined || p === null ? '' : String(p)))
    .join(':');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

/** The single comparison, shared so both scopes report staleness the same way. */
function compareToken(currentToken, clientToken) {
  if (!clientToken || clientToken !== currentToken) {
    return { valid: false, new_token: currentToken };
  }
  return { valid: true };
}

/**
 * CACHE FRESHNESS — has anything this client caches changed?
 *
 * Token = hash of (user_id + max updated_at of the user's memories + max updated_at of
 * team_standards + the account's locale preference). Any write to any of those changes the
 * token, and `hooks/lib/conditional-sync.js` re-inits on the mismatch.
 *
 * `locale` is here because a locale write (PUT /api/memory/locale) only touches
 * `users.settings`, never `memories.updated_at`. Without it the preference would sit on the
 * server invisible to every machine until an unrelated write happened to bump the token or
 * the 24h staleness fallback fired. Both `GET /sync-token` and `GET /init` call this same
 * function, so they can never disagree about the current value.
 *
 * Anything else the client starts caching belongs in these inputs too. Do NOT reach for this
 * function to guard a narrower write — see `generateIronRuleLockToken`.
 *
 * v1.18.0: query is injectable (defaults to db.js) so the endpoint's logic is testable
 * without standing up an integration environment.
 */
export async function generateSyncToken(userId, queryFn = defaultQuery) {
  const result = await queryFn(
    `SELECT
       COALESCE(MAX(updated_at)::text, '') AS user_max,
       (SELECT COALESCE(MAX(updated_at)::text, '')
        FROM memories WHERE type = 'team_standard' AND status = 'active') AS team_max,
       (SELECT COALESCE(settings->>'locale', '') FROM users WHERE id = $1) AS locale
     FROM memories
     WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );

  const { user_max, team_max, locale } = result.rows[0];
  return hashScopedState(null, [userId, user_max, team_max, locale || '']);
}

/**
 * Validate a cache-freshness token from a request.
 * Returns: { valid: true } | { valid: false, new_token: string }
 */
export async function validateSyncToken(userId, clientToken, queryFn = defaultQuery) {
  return compareToken(await generateSyncToken(userId, queryFn), clientToken);
}

/**
 * IRON-RULE LOCK — did iron-rule state move under this editor?
 *
 * The optimistic lock behind `src/routes/admin-iron-rule-upgrade.js`: `GET /upgrade-status`
 * issues this token with the rule list, `PUT /:id/upgrade` requires it back, and the 409 it
 * raises means "your snapshot is out of date, reload". It exists to stop the editor writing
 * a stale `previous_content` over a change that landed while the modal was open.
 *
 * Inputs are exactly the row set `GET /upgrade-status` returns — the user's active iron
 * rules — and nothing else:
 *
 *   MAX(updated_at)  any edit that bumps a rule's updated_at, including one arriving from
 *                    ownmind_save. Nothing in this schema bumps it automatically — there is
 *                    no trigger, every UPDATE sets it by hand — so a write that deliberately
 *                    leaves the timestamp alone stays invisible here. The one that does that
 *                    today is the rule_stats merge in src/routes/memory.js, which the upgrade
 *                    PUT does not write, so it cannot clobber what the lock cannot see.
 *   COUNT(*)         a rule added or disabled; on its own MAX can miss a rule leaving the
 *                    active set when it was not the most recently touched one
 *
 * Everything the previous shared implementation folded in beyond this — other memory types,
 * other users' team standards, the account's locale — could only ever produce a conflict for
 * a change that cannot affect any iron rule. That is not extra safety; it is an eviction
 * notice served to someone mid-edit for something they did in another tab.
 */
export async function generateIronRuleLockToken(userId, queryFn = defaultQuery) {
  const result = await queryFn(
    `SELECT
       COALESCE(MAX(updated_at)::text, '') AS iron_rule_max,
       COUNT(*)::text AS iron_rule_count
     FROM memories
     WHERE user_id = $1 AND type = 'iron_rule' AND status = 'active'`,
    [userId]
  );

  const { iron_rule_max, iron_rule_count } = result.rows[0];
  return hashScopedState('iron_rule_lock', [userId, iron_rule_max, iron_rule_count]);
}

/**
 * Validate an iron-rule lock token echoed back by the upgrade editor.
 * Returns: { valid: true } | { valid: false, new_token: string }
 */
export async function validateIronRuleLockToken(userId, clientToken, queryFn = defaultQuery) {
  return compareToken(await generateIronRuleLockToken(userId, queryFn), clientToken);
}
