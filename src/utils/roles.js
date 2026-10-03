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

/**
 * May `actor` see `target`'s full API key? Their own, or a strictly lower rank's.
 *
 * Authentication finds the user by key alone, so a key is the account. Equal rank is
 * refused on purpose: an admin holding another admin's key, or a super_admin another
 * super_admin's, could act as them with nothing in the audit log saying so.
 * client/src/pages/Admin/menu-visibility.js mirrors this rule; a test pins the two together.
 *
 * @param {{ id: number, role: string }} actor
 * @param {{ id: number, role: string }} target
 */
export function mayRevealKeyOf(actor, target) {
  if (!actor || !target) return false;
  if (actor.id === target.id) return true;
  return (ROLE_RANK[actor.role] ?? -1) > (ROLE_RANK[target.role] ?? 99);
}
