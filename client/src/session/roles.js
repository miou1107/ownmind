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

export { ROLE_RANK };
