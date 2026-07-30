// Role ladder and the route-gate decision, kept free of React so both can be imported
// and executed by tests.
//
// SessionContext.jsx and RequireRole.jsx both need this, and both contain JSX, which
// node --test cannot parse. Splitting the decision out of the binding is the same move
// as src/utils/spa-shell.js on the server side: pure logic in a plain module, the
// framework wiring separately, and the part that decides who gets in covered by tests
// that actually run it rather than by reading its source.
//
// decideRoleGate exists because the first version of this stage left the decision inline
// in the component, and the test that was supposed to cover it asserted that the word
// "ready" appeared before "<Navigate>" in the file. Review showed that assertion passes
// for a guard that checks the role first and readiness second — the exact bug it claimed
// to prevent. Reading source text cannot verify an ordering; running the function can.

// Object.create(null) rather than a literal: a literal inherits from Object.prototype,
// so ROLE_RANK['valueOf'] would be a function instead of undefined and `??` would never
// fire. Measured before this fix: roleAtLeast('valueOf', 'valueOf') returned true, which
// is the opposite of the fail-closed contract documented below.
const ROLE_RANK = Object.assign(Object.create(null), {
  user: 1,
  admin: 2,
  super_admin: 3,
});

/**
 * Does `role` meet the `min` requirement?
 *
 * Both unknown inputs fail closed, and they fail closed differently on purpose:
 * an unranked role scores 0 so it never clears a real bar, and an unrecognised
 * requirement is treated as unreachable so a typo in a guard denies everyone rather
 * than admitting everyone. A guard that silently opens is worse than one that
 * visibly blocks.
 *
 * @param {string|null|undefined} role the role the server reported
 * @param {string} min the lowest role allowed through
 * @returns {boolean}
 */
export function roleAtLeast(role, min) {
  const have = ROLE_RANK[role] ?? 0;
  const want = ROLE_RANK[min] ?? Number.POSITIVE_INFINITY;
  return have >= want;
}

/**
 * What should a role-gated route do right now?
 *
 * Three outcomes, and the order they are decided in is the whole point:
 *
 *   'wait'  the identity has not resolved yet — render nothing, decide later
 *   'deny'  resolved, and this role is not allowed here
 *   'allow' resolved, and this role is allowed here
 *
 * Readiness is checked first. Deciding while the identity is in flight would redirect a
 * legitimate admin away from the page they asked for, because an unresolved session
 * looks identical to a role-less one.
 *
 * @param {{ ready: boolean, role: string|null|undefined, min: string }} state
 * @returns {'wait'|'deny'|'allow'}
 */
export function decideRoleGate({ ready, role, min }) {
  if (!ready) return 'wait';
  return roleAtLeast(role, min) ? 'allow' : 'deny';
}

/** The role every authenticated member has. A route open to it needs no role guard. */
export const BASE_ROLE = 'user';

/**
 * Which wrapper a route needs: 'open' for anyone with a session, 'gated' when a role is
 * required.
 *
 * Extracted for the same reason as decideRoleGate. The first version was a ternary inside
 * App.jsx, covered by a test that matched that ternary's source text — which verifies no
 * behaviour, breaks when a local variable is renamed, and was the exact antipattern the
 * previous round removed from this file. Reversing the condition would gate every personal
 * page and open every admin one, so it is worth running.
 *
 * Anything that is not the base role is gated, including an unrecognised value, so a typo
 * in a nav item's minRole yields a locked page rather than an open one.
 *
 * @param {string|null|undefined} minRole
 * @returns {'open'|'gated'}
 */
export function routeTierFor(minRole) {
  return minRole === BASE_ROLE ? 'open' : 'gated';
}

/**
 * Where a denied role is sent.
 *
 * Lives here rather than inline in RequireRole so the route table and the guard read the
 * same constant. The destination must itself be reachable by every role, or a session whose
 * identity failed to resolve bounces from the fallback to the fallback forever. Asserted by
 * tests/console-nav-structure.test.js against the navigation's own minRole for this path.
 */
export const ROLE_DENIED_REDIRECT = '/portal/usage';

export { ROLE_RANK };
