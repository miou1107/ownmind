// What the console does with a login response.
//
// Three outcomes, not two: v1.26.59 retires the legacy console, which was the only UI
// able to finish the sole-admin recovery that scripts/reset-admin-password.js starts.
// The server now answers that state with `{ requiresSetup: true }` on a 200, so the
// success shape no longer implies a session.
//
// Pure so a test runs it. The ordering matters: `ok: true` is the success shape, and a
// branch written the other way round would call setApiKey(undefined) and prime a
// session with no identity — a console that looks logged in as nobody.

/**
 * @param {{ ok: boolean, data?: object, error?: string }} response
 * @returns {{ kind: 'authenticated', data: object }
 *          | { kind: 'setup' }
 *          | { kind: 'first_password' }
 *          | { kind: 'error', error?: string }}
 */
export function decideLoginOutcome(response) {
  if (!response?.ok) return { kind: 'error', error: response?.error };
  const data = response.data;
  // Checked before the api_key branch, and against a literal true: a truthy-but-not-true
  // value means the server said something this client does not understand, and guessing
  // "setup" would show a password-setting form on a hunch.
  if (data?.requiresSetup === true) return { kind: 'setup' };
  // v1.26.63: the password was right, but the account is still on the temporary one the
  // admin relayed, so the server issued no key. Ahead of the api_key branch for the same
  // reason `setup` is: a 200 carrying no key is no longer only a client-server mismatch.
  // Behind `setup` because "no password at all" is a different, older state than
  // "has a temporary one", and only the setup form can finish it.
  if (data?.mustSetPassword === true) return { kind: 'first_password' };
  if (!data?.api_key) return { kind: 'error' };
  return { kind: 'authenticated', data };
}
