// v1.26.63 — the decisions that stop a temporary password becoming a permanent api_key.
//
// These are security decisions, so they live in a pure module and are executed here
// rather than asserted by reading the route (the reasoning src/utils/setup-recovery.js
// already records: this repo has no CI).
//
// Two properties matter more than any single case:
//   1. Login must not hand out api_key while the account is still on a temporary password.
//   2. No refusal may reveal whether an account exists, or whether it is still on a
//      temporary password. Every rejection has to be one indistinguishable answer.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loginResponseFor, firstPasswordRefusal }
  from '../src/utils/first-password.js';
import { LOGIN_REJECTED } from '../src/utils/setup-recovery.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function user(overrides = {}) {
  return {
    id: 4,
    email: 'joanna@fontrip.com',
    name: 'Joanna',
    role: 'user',
    api_key: 'om_live_key',
    password_hash: '$2b$10$hash',
    must_change_password: false,
    ...overrides,
  };
}

describe('loginResponseFor', () => {
  it('gives no key to an account still on a temporary password', () => {
    const { status, body } = loginResponseFor(user({ must_change_password: true }));
    assert.equal(status, 200);
    assert.deepEqual(body, { mustSetPassword: true });
    // Not `api_key: null` — absent. A client reading the field would otherwise store
    // the string "null" and believe it holds a session.
    assert.equal('api_key' in body, false);
    assert.equal('id' in body, false);
    assert.equal('role' in body, false);
  });

  it('gives the ordinary account everything it got before', () => {
    const u = user();
    const { status, body } = loginResponseFor(u);
    assert.equal(status, 200);
    assert.equal(body.api_key, 'om_live_key');
    assert.equal(body.id, 4);
    assert.equal(body.name, 'Joanna');
    assert.equal(body.email, 'joanna@fontrip.com');
    assert.equal(body.role, 'user');
    assert.equal(body.must_change_password, false);
  });

  it('treats any truthy flag as set, since the column is nullable', () => {
    assert.equal('api_key' in loginResponseFor(user({ must_change_password: true })).body, false);
    // A NULL column must read as "not required", the same as FALSE.
    assert.equal(loginResponseFor(user({ must_change_password: null })).body.api_key, 'om_live_key');
  });
});

describe('firstPasswordRefusal — shape', () => {
  const set = { user: user({ must_change_password: true }), passwordOk: true };

  it('refuses a missing field', () => {
    for (const args of [
      { ...set, currentPassword: '', newPassword: 'a-good-password' },
      { ...set, currentPassword: 'temp1234', newPassword: '' },
      { ...set, currentPassword: undefined, newPassword: undefined },
    ]) {
      assert.equal(firstPasswordRefusal(args)?.status, 400);
    }
  });

  it('refuses a new password under eight characters', () => {
    assert.equal(firstPasswordRefusal({ ...set, currentPassword: 'temp1234', newPassword: 'short' })?.status, 400);
  });

  it('refuses a new password identical to the temporary one', () => {
    assert.equal(firstPasswordRefusal({ ...set, currentPassword: 'temp1234', newPassword: 'temp1234' })?.status, 400);
  });
});

describe('firstPasswordRefusal — credentials', () => {
  const good = { currentPassword: 'temp1234', newPassword: 'my-own-password' };

  it('lets a correct temporary password through', () => {
    const r = firstPasswordRefusal({ user: user({ must_change_password: true }), passwordOk: true, ...good });
    assert.equal(r, null);
  });

  it('refuses a wrong temporary password', () => {
    const r = firstPasswordRefusal({ user: user({ must_change_password: true }), passwordOk: false, ...good });
    assert.equal(r.status, 401);
  });

  it('refuses an unknown account', () => {
    assert.equal(firstPasswordRefusal({ user: null, passwordOk: false, ...good }).status, 401);
  });

  it('refuses an account that has no password at all', () => {
    const u = user({ must_change_password: true, password_hash: null });
    assert.equal(firstPasswordRefusal({ user: u, passwordOk: false, ...good }).status, 401);
  });

  it('refuses an account that already chose its own password', () => {
    // Otherwise this becomes an unauthenticated password-change endpoint for anyone who
    // learns a current password, sitting outside the signed-in change-password flow.
    const r = firstPasswordRefusal({ user: user({ must_change_password: false }), passwordOk: true, ...good });
    assert.equal(r.status, 401);
  });
});

describe('firstPasswordRefusal — reveals nothing', () => {
  const good = { currentPassword: 'temp1234', newPassword: 'my-own-password' };

  it('answers every credential failure with one identical body', () => {
    const bodies = [
      firstPasswordRefusal({ user: null, passwordOk: false, ...good }),
      firstPasswordRefusal({ user: user({ must_change_password: true }), passwordOk: false, ...good }),
      firstPasswordRefusal({ user: user({ must_change_password: false }), passwordOk: true, ...good }),
      firstPasswordRefusal({ user: user({ must_change_password: true, password_hash: null }), passwordOk: false, ...good }),
    ].map((r) => JSON.stringify({ status: r.status, body: r.body }));

    assert.equal(new Set(bodies).size, 1, `four rejections produced ${new Set(bodies).size} distinct answers: ${[...new Set(bodies)].join(' | ')}`);
    assert.deepEqual(JSON.parse(bodies[0]).body, { ...LOGIN_REJECTED });
  });

  it('checks the password shape before the credentials, so a 400 says nothing about the account', () => {
    // If credentials were checked first, "400 too short" versus "401 rejected" would tell
    // a prober that the email and temporary password they tried were correct.
    const real = firstPasswordRefusal({
      user: user({ must_change_password: true }), passwordOk: true,
      currentPassword: 'temp1234', newPassword: 'short',
    });
    const fake = firstPasswordRefusal({
      user: null, passwordOk: false,
      currentPassword: 'whatever', newPassword: 'short',
    });
    assert.equal(real.status, 400);
    assert.deepEqual(real, fake);
  });
});

describe('the endpoint is rate limited', () => {
  // A structural check, deliberately. Forgetting the limiter is the one mistake in this
  // release that no behavioural test would catch: the handler would work perfectly and
  // the endpoint would simply accept unlimited password guesses. The same omission
  // already happened once — v1.26.60 found that the console's own login had never been
  // behind authLimiter after the console was rebuilt.
  const appSource = readFileSync(join(repoRoot, 'src/app.js'), 'utf8');

  it('mounts authLimiter on /api/me/first-password', () => {
    assert.match(
      appSource,
      /app\.use\(\s*['"]\/api\/me\/first-password['"]\s*,\s*authLimiter\s*\)/,
      'POST /api/me/first-password verifies a password while unauthenticated; without authLimiter it accepts unlimited guesses',
    );
  });

  it('still mounts it on /api/me/login', () => {
    assert.match(appSource, /app\.use\(\s*['"]\/api\/me\/login['"]\s*,\s*authLimiter\s*\)/);
  });
});
