// Which dropdown items to render for a given (actor, row) pair.
//
// Requirement 4 of openspec/changes/archive/v1.26.49-team-management-page/spec.md.
//
// The item set is fixed at five ids in a fixed order; the visible subset is
// derived per-row. The predicates mirror what the server enforces
// (src/routes/admin.js:238-311,345-357): showing a button the server would
// reject teaches the admin to distrust the UI, so we hide it instead.
//
// Pure function on purpose — testable without a DOM, and the RowMenu component
// consumes the returned list as its render source of truth.

const ORDER = ['install-prompt', 'rotate-key', 'edit', 'password', 'delete'];

const RANK = { user: 0, admin: 1, super_admin: 2 };

/**
 * Whether the server will hand `actor` the full API key of `row`: their own, or a strictly
 * lower rank's. Mirrors mayRevealKeyOf in src/utils/roles.js (the client bundle cannot
 * import server code); tests/admin-api-key-reveal.test.js checks the two agree on every
 * pairing.
 */
export function canRevealKeyOf(actor, row) {
  if (!actor || !row) return false;
  if (actor.id === row.id) return true;
  return (RANK[actor.role] ?? -1) > (RANK[row.role] ?? 99);
}

/**
 * @param {{ id: number, role: 'user'|'admin'|'super_admin' }} actor  Who's clicking.
 * @param {{ id: number, role: 'user'|'admin'|'super_admin' }} row    Whose menu is being opened.
 * @returns {string[]}                                                Ordered ids to render.
 */
export function visibleMenuItems(actor, row) {
  const isSelf = actor.id === row.id;
  const actorIsSuper = actor.role === 'super_admin';

  const show = {
    // The prompt carries the row's full API key, so it is offered only where the server
    // will reveal that key: yourself, or someone ranked below you. It used to be offered
    // for everyone, on the reasoning that the key was already in the row — which was the
    // flaw: an admin could copy a super_admin's key and become them.
    'install-prompt': canRevealKeyOf(actor, row),

    // Issuing someone a new key is holding their account, so the same rule as revealing it
    // (src/routes/api-key-rotate.js enforces it on the server).
    'rotate-key': canRevealKeyOf(actor, row),

    // Every actor can edit any row's role or display name. Server enforces the
    // hard rules (admin cannot touch super_admin, cannot demote the last
    // super_admin, cannot change own role), and a failed PUT surfaces those as
    // form-level errors — visible entry point + server-enforced boundary is the
    // standard shape here.
    edit: true,

    // Legacy behaviour (src/public/index.html:1250): show `修改密碼` when
    //   isSelf                                       — user changes own password
    //   OR (super_admin AND row.role !== 'user')     — super_admin resets an
    //                                                   admin's or another
    //                                                   super_admin's password
    // A super_admin cannot reset a plain user's password through this modal;
    // for that, the create-user default_password flow is used instead
    // (unsurfaced emergency endpoint is deliberate scope, this stage).
    password: isSelf || (actorIsSuper && row.role !== 'user'),

    // super_admin only; not self; not id=1 (seed super_admin, one recovery path
    // depends on it). Server enforces all three at src/routes/admin.js:281-283.
    delete: actorIsSuper && !isSelf && row.id !== 1,
  };

  return ORDER.filter((id) => show[id]);
}
