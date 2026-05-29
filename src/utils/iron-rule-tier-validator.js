/**
 * Iron Rule Tier — server route validator
 *
 * Extracts the server-side validation logic for v1.19 iron-rule tiers; pure function, easy to test.
 * Corresponding spec: openspec/changes/v1.19-iron-rule-tier/spec.md scenarios 3 and 4
 *
 * Design points:
 *   - tier is an optional field; old clients that omit tier still write fine
 *   - tier is only allowed on type='iron_rule' memories
 *   - any invalid tier value is rejected with a clear message, no silent fallback
 *     (fallback is the client/hook side's responsibility; the server should be strict)
 */

import { isValidTier, VALID_TIERS, normalizeTier } from '../../shared/iron-rule-tier.js';

/**
 * Validate the tier field of a write request
 *
 * @param {object} params
 * @param {string} params.memoryType — the memory's type field (iron_rule / project / ...)
 * @param {string} [params.tier] — the tier value carried by the request
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function validateTierRequest({ memoryType, tier }) {
  // 1. no tier -> always ok (backward compatible, old clients do not break)
  if (tier === undefined || tier === null) {
    return { ok: true };
  }

  // 2. tier present but type missing -> reject (guard)
  if (!memoryType) {
    return {
      ok: false,
      status: 400,
      error: 'tier field must be written together with an explicit type',
    };
  }

  // 3. tier can only be used on iron rules
  if (memoryType !== 'iron_rule') {
    return {
      ok: false,
      status: 400,
      error: `tier can only be set on type='iron_rule' memories (got type='${memoryType}')`,
    };
  }

  // 4. tier value must be valid
  if (!isValidTier(tier)) {
    return {
      ok: false,
      status: 400,
      error: `tier must be one of: ${VALID_TIERS.join(', ')} (got: '${tier}')`,
    };
  }

  return { ok: true };
}

/**
 * Decide the tier value written to the DB (fallback)
 *
 * Normal flow: the caller should call validateTierRequest first and return 400 on error.
 * This function is just a fallback that guarantees the tier written to the DB is always valid.
 *
 * @param {object} params
 * @param {string} params.memoryType
 * @param {string} [params.tier]
 * @returns {string|null} — returns a valid tier string for iron_rule, null for other types
 */
export function applyTierDefault({ memoryType, tier }) {
  if (memoryType !== 'iron_rule') {
    return null;
  }
  if (tier === undefined || tier === null) {
    return 'default';
  }
  return normalizeTier(tier);
}
