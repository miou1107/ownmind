// Which dropdown items to render for a given (actor, row) pair.
//
// Requirement 4 of openspec/changes/archive/v1.26.49-team-management-page/spec.md.
//
// The item set is fixed at four ids in a fixed order; the visible subset is
// derived per-row. The predicates mirror what the server enforces
// (src/routes/admin.js:238-311,345-357): showing a button the server would
// reject teaches the admin to distrust the UI, so we hide it instead.
//
// Pure function on purpose — testable without a DOM, and the RowMenu component
// consumes the returned list as its render source of truth.

const ORDER = ['install-prompt', 'edit', 'password', 'delete'];

/**
 * @param {{ id: number, role: 'user'|'admin'|'super_admin' }} actor  Who's clicking.
 * @param {{ id: number, role: 'user'|'admin'|'super_admin' }} row    Whose menu is being opened.
 * @returns {string[]}                                                Ordered ids to render.
 */
export function visibleMenuItems(actor, row) {
  const isSelf = actor.id === row.id;
  const actorIsSuper = actor.role === 'super_admin';

  const show = {
    // Every actor can copy an install prompt for anyone: the api_key is already
    // visible in the row above, so surfacing the prompt is not an escalation.
    'install-prompt': true,

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
