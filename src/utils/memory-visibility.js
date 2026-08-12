/**
 * Shared read visibility for memories.
 *
 * Most memory types belong to one account and are only ever read by their
 * owner. Team standards are the exception: the `team_standard` summary layer is
 * global by design, and the `standard_detail` fragments it points at carry the
 * text that makes the summary useful. Before v1.26.38 only the summary layer
 * was shared, so every member loaded a shelf of standard titles whose contents
 * nobody but the uploader could open.
 *
 * This module owns the single predicate that decides "may this caller read this
 * row", so the type, search, and by-id routes cannot drift apart again.
 *
 * Read access only — being able to read a shared fragment must never imply being
 * able to change it. Who may change one is decided in `memory-write-access.js`:
 * its owner, or an admin (v1.26.147, issue #85; before that, only its owner,
 * which left standards spread across accounts with no one able to edit them all).
 */

/** Memory types that are readable across accounts. */
export const SHARED_MEMORY_TYPES = Object.freeze(['team_standard', 'standard_detail']);

/**
 * @param {unknown} type
 * @returns {boolean} true when rows of this type are readable across accounts
 */
export function isSharedMemoryType(type) {
  return typeof type === 'string' && SHARED_MEMORY_TYPES.includes(type);
}

/**
 * Build the SQL predicate for "rows this caller may read".
 *
 * A fragment is visible when its parent summary is an active `team_standard`
 * that the caller has not opted out of, so retiring a summary also retires its
 * fragments instead of stranding them.
 *
 * The parent is matched by comparing `parent.id::text` against the JSON string
 * rather than casting the JSON value to int: a malformed or absent `parent_id`
 * then yields no match, instead of aborting the whole query with a cast error.
 *
 * @param {object} [options]
 * @param {string} [options.alias] table alias used by the surrounding query
 * @param {string} [options.userParam] placeholder holding the caller's user id
 * @returns {string} a parenthesised expression safe to AND into a WHERE clause
 */
export function buildReadableWhere({ alias = 'm', userParam = '$1' } = {}) {
  return `(
      ${alias}.user_id = ${userParam}
      OR ${alias}.type = 'team_standard'
      OR (
        ${alias}.type = 'standard_detail'
        AND EXISTS (
          SELECT 1 FROM memories parent
           WHERE parent.id::text = ${alias}.metadata->>'parent_id'
             AND parent.type = 'team_standard'
             AND parent.status = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM memories optout
                WHERE optout.user_id = ${userParam}
                  AND optout.type = 'profile'
                  AND optout.status = 'active'
                  AND optout.tags @> ARRAY['team_standard_optout']
                  AND optout.metadata->>'team_standard_id' = parent.id::text
             )
        )
      )
    )`;
}
