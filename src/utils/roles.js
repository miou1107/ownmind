/**
 * Role ranking.
 *
 * Lives in utils rather than in the middleware that used to own it so that code deciding
 * "may this caller do this" can import the comparison without pulling in the auth
 * middleware, and through it the database pool. `src/middleware/adminAuth.js` re-exports
 * `isAtLeast` from here, so there is still one definition of the ranking.
 */

/** Higher rank may do everything the ranks below it may do. */
export const ROLE_RANK = Object.freeze({ user: 0, admin: 1, super_admin: 2 });

/**
 * @param {unknown} userRole role held by the caller
 * @param {string} required minimum role the operation asks for
 * @returns {boolean} true when the caller ranks at or above the requirement
 */
export function isAtLeast(userRole, required) {
  return (ROLE_RANK[userRole] ?? -1) >= (ROLE_RANK[required] ?? 99);
}
