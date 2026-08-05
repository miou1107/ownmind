// v1.26.63 — stopping a temporary password from becoming a permanent api_key.
//
// seedDefaultPasswords generates a random password, writes it to the server log once, and
// sets must_change_password = TRUE. The admin relays it, usually over chat. Until this
// release, POST /api/me/login then answered that password with the account's permanent
// api_key — the same credential the MCP holds, which never expires — and the only thing
// still asking for a replacement was a localStorage flag the holder could delete.
//
// So the requirement moves to where the temporary password is actually spent: login
// issues nothing, and POST /api/me/first-password issues the key only as part of
// replacing the password.
//
// Pure, for the reason src/utils/setup-recovery.js already records: these are security
// decisions, this repo has no CI, and a decision left inline in a 1119-line route is
// asserted rather than executed.

import { LOGIN_REJECTED } from './setup-recovery.js';

const MIN_PASSWORD_LENGTH = 8;

/**
 * What POST /api/me/login answers once the password has been verified.
 *
 * @param {object} user  The users row.
 * @returns {{ status: number, body: object }}
 */
export function loginResponseFor(user) {
  if (user.must_change_password) {
    // No id, no role, no api_key, and the key absent rather than null: a client reading
    // an `api_key` field would otherwise store "null" and believe it holds a session.
    return { status: 200, body: { mustSetPassword: true } };
  }
  return {
    status: 200,
    body: {
      id: user.id,
      api_key: user.api_key,
      name: user.name,
      email: user.email,
      role: user.role,
      must_change_password: false,
    },
  };
}

/**
 * Why POST /api/me/first-password must refuse, or null to go ahead.
 *
 * The shape of the new password is checked *before* the credentials on purpose. Checking
 * credentials first would make "400 too short" mean the email and temporary password were
 * right, and "401 rejected" mean they were wrong — an oracle on an unauthenticated
 * endpoint. Shape-first, every prober gets the same 400 whatever they guessed.
 *
 * Every credential refusal is the same object login gives, so the endpoint cannot be used
 * to find out which accounts exist or which are still on a temporary password.
 *
 * @param {object} args
 * @param {object|null} args.user            The users row, or null when the email is unknown.
 * @param {boolean} args.passwordOk          Result of bcrypt.compare against the stored hash.
 * @param {string} args.currentPassword
 * @param {string} args.newPassword
 * @returns {{ status: number, body: object }|null}
 */
export function firstPasswordRefusal({ user, passwordOk, currentPassword, newPassword }) {
  const current = String(currentPassword ?? '');
  const next = String(newPassword ?? '');

  if (!current || !next) {
    return { status: 400, body: { error: '請輸入臨時密碼和新密碼' } };
  }
  if (next.length < MIN_PASSWORD_LENGTH) {
    return { status: 400, body: { error: `新密碼長度至少 ${MIN_PASSWORD_LENGTH} 字元` } };
  }
  if (next === current) {
    return { status: 400, body: { error: '新密碼必須跟臨時密碼不一樣' } };
  }

  // Everything below answers with one indistinguishable rejection.
  if (!user) return rejected();
  if (!user.password_hash) return rejected();
  // Without this the endpoint becomes an unauthenticated password change for anyone who
  // learns a current password, standing outside the signed-in change-password flow.
  if (!user.must_change_password) return rejected();
  if (!passwordOk) return rejected();

  return null;
}

function rejected() {
  return { status: 401, body: { ...LOGIN_REJECTED } };
}
