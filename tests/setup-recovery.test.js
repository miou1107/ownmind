// v1.26.59 — the sole-admin recovery path, which the /admin retirement would
// otherwise cut.
//
// scripts/reset-admin-password.js sets a super_admin's password_hash to NULL and then
// tells the operator to finish in a browser. The only UI that ever finished it was the
// legacy console's setup form, reached through /admin/. This release stops serving
// /admin/, so the console has to answer that state itself — otherwise a locked-out sole
// super_admin has no route back in through any interface.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { noPasswordLoginResponse, LOGIN_REJECTED } from '../src/utils/setup-recovery.js';
import { decideLoginOutcome } from '../client/src/pages/login-outcome.js';

describe('noPasswordLoginResponse — who is offered the setup form', () => {
  it('a super_admin during a rescue window is offered it', () => {
    const r = noPasswordLoginResponse({ role: 'super_admin', setupTokenConfigured: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { requiresSetup: true });
  });

  it('a super_admin outside a rescue window is not', () => {
    // POST /api/admin/setup refuses everything when SETUP_TOKEN is unset, so offering
    // the form would be a dead end. Staying on the generic 401 also means the response
    // says nothing about this account to anyone who did not already start the rescue.
    // This is deliberately tighter than the legacy /api/admin/login it replaces, which
    // announced requiresSetup to any caller.
    const r = noPasswordLoginResponse({ role: 'super_admin', setupTokenConfigured: false });
    assert.equal(r.status, 401);
    assert.equal(r.body.requiresSetup, undefined);
    // Byte-identical to what an unknown email gets. Asserting merely that *an* error
    // is present is how the first version of this test passed while the response still
    // said "this account has no password yet", which tells an attacker probing random
    // addresses that this one is a real account. Compared against the constant the
    // route's other two rejection branches use, so the three cannot drift apart.
    assert.equal(r.body.error, LOGIN_REJECTED.error);
  });

  it('the rejection is the same object shape whoever asks', () => {
    const rejections = [
      noPasswordLoginResponse({ role: 'super_admin', setupTokenConfigured: false }),
      noPasswordLoginResponse({ role: 'admin', setupTokenConfigured: true }),
      noPasswordLoginResponse({ role: 'user', setupTokenConfigured: true }),
    ];
    for (const r of rejections) {
      assert.deepEqual(r.body, LOGIN_REJECTED);
    }
  });

  it('the generic rejection says nothing about passwords or accounts existing', () => {
    assert.ok(!/尚未設定密碼|not set|no password/i.test(LOGIN_REJECTED.error));
  });

  it('nobody below super_admin is offered it, token or not', () => {
    // The setup endpoint filters `role = 'super_admin'`, so an admin who reached the
    // form would fill it in and be refused. The honest answer for them is the same as
    // today: ask an administrator.
    for (const role of ['admin', 'user']) {
      const r = noPasswordLoginResponse({ role, setupTokenConfigured: true });
      assert.equal(r.status, 401, role);
      assert.equal(r.body.requiresSetup, undefined, role);
    }
  });

  it('an unrecognised role fails closed', () => {
    for (const role of [undefined, null, '', 'root', 'SUPER_ADMIN']) {
      const r = noPasswordLoginResponse({ role, setupTokenConfigured: true });
      assert.equal(r.status, 401, String(role));
    }
  });

  it('the offered response carries no account detail', () => {
    // A 200 here is unauthenticated by definition. It must not become a way to read
    // a name, an email or an api_key out of the server.
    const r = noPasswordLoginResponse({ role: 'super_admin', setupTokenConfigured: true });
    assert.deepEqual(Object.keys(r.body), ['requiresSetup']);
  });
});

describe('decideLoginOutcome — what the console does with the answer', () => {
  const ok = (data) => ({ ok: true, data });

  it('a normal login authenticates', () => {
    const d = decideLoginOutcome(ok({ api_key: 'k', role: 'user' }));
    assert.equal(d.kind, 'authenticated');
  });

  it('requiresSetup switches to the setup form instead of authenticating', () => {
    const d = decideLoginOutcome(ok({ requiresSetup: true }));
    assert.equal(d.kind, 'setup');
  });

  it('a failure is a failure', () => {
    const d = decideLoginOutcome({ ok: false, error: 'nope' });
    assert.equal(d.kind, 'error');
    assert.equal(d.error, 'nope');
  });

  it('requiresSetup is never treated as a login, even if a key comes with it', () => {
    // The dangerous confusion: `ok:true` is the success shape, so a branch ordered the
    // other way would call setApiKey(undefined) and prime a session with no identity —
    // a logged-in-looking console belonging to nobody.
    const d = decideLoginOutcome(ok({ requiresSetup: true, api_key: 'leaked' }));
    assert.equal(d.kind, 'setup');
  });

  it('a success with no api_key is an error, not a half-login', () => {
    assert.equal(decideLoginOutcome(ok({ role: 'user' })).kind, 'error');
    assert.equal(decideLoginOutcome(ok(null)).kind, 'error');
    assert.equal(decideLoginOutcome({ ok: true }).kind, 'error');
  });

  it('only a literal true opens the setup form', () => {
    // A truthy-but-not-true value means the server said something this client does not
    // understand; guessing "setup" would show a password-setting form on a hunch.
    for (const v of ['true', 1, {}]) {
      assert.notEqual(decideLoginOutcome(ok({ requiresSetup: v, api_key: 'k' })).kind, 'setup');
    }
  });
});
