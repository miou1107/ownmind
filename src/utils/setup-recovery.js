// The sole-admin recovery path.
//
// scripts/reset-admin-password.js clears a super_admin's password_hash and then tells
// the operator to finish setting a new one in a browser. Until v1.26.59 the only UI that
// could finish it was the legacy console's setup form at /admin/, and v1.26.59 stops
// serving /admin/. So POST /api/me/login has to recognise the state the script leaves
// behind, or a locked-out sole super_admin has no way back in through any interface.
//
// Extracted as a pure function because it is a security decision — who is told that an
// account has no password — and this repo has no CI, so a decision left inline in the
// route is asserted rather than executed.

/** Roles POST /api/admin/setup will actually serve (src/routes/admin.js: role = 'super_admin'). */
const SETUP_ELIGIBLE_ROLES = new Set(['super_admin']);

/**
 * The one rejection POST /api/me/login gives, whatever went wrong.
 *
 * Exported so the route's three failing branches — unknown email, wrong password, and
 * the no-password case below — are literally the same object. Until v1.26.59 the third
 * answered '此帳號尚未設定密碼，請聯絡管理員', which is a different string from the
 * other two, so probing addresses told an attacker which ones are real accounts. Found
 * in adversarial review of this change; the message predates it, but this is the branch
 * being rewritten and the spec promised the response reveals nothing.
 *
 * The cost is a worse message for an admin created without a password, who now reads
 * "wrong email or password". They cannot log in either way, and whoever created the
 * account is the one who has to fix it.
 */
export const LOGIN_REJECTED = Object.freeze({ error: '帳號或密碼錯誤' });

/**
 * What POST /api/me/login answers when the account exists but has no password.
 *
 * Two conditions, both required:
 *
 *   - the role is one POST /api/admin/setup will serve. Offering the form to an admin
 *     would send them to an endpoint that filters them out.
 *   - SETUP_TOKEN is configured. The setup endpoint refuses everything without it, so
 *     outside a rescue window the form leads nowhere — and staying on the generic 401
 *     means the response reveals nothing about the account to anyone who did not
 *     already start the rescue. This is deliberately tighter than the legacy
 *     /api/admin/login, which announced `requiresSetup` to any caller.
 *
 * @param {object} args
 * @param {string} args.role
 * @param {boolean} args.setupTokenConfigured
 * @returns {{ status: number, body: object }}
 */
export function noPasswordLoginResponse({ role, setupTokenConfigured }) {
  if (setupTokenConfigured && SETUP_ELIGIBLE_ROLES.has(role)) {
    // No account detail: this response is unauthenticated by definition.
    return { status: 200, body: { requiresSetup: true } };
  }
  return { status: 401, body: { ...LOGIN_REJECTED } };
}
