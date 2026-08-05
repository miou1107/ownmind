// v1.26.63 — the console's reading of a login response.
//
// The module gains a fourth outcome because v1.26.63 makes a successful login able to
// answer "correct, but you have no credential yet". Before this, "200 with no api_key"
// could only be a server the client did not understand, so it mapped to an error; now it
// is a real state with a form behind it.
//
// The ordering is the point. A branch written the other way round would call
// setApiKey(undefined) and prime a session with no identity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideLoginOutcome } from '../client/src/pages/login-outcome.js';

describe('decideLoginOutcome — the new outcome', () => {
  it('reads mustSetPassword as its own outcome', () => {
    assert.deepEqual(
      decideLoginOutcome({ ok: true, data: { mustSetPassword: true } }),
      { kind: 'first_password' },
    );
  });

  it('does not guess from a truthy-but-not-true value', () => {
    // Same discipline as requiresSetup: a value this client does not understand must not
    // be turned into a password-setting form on a hunch.
    for (const v of ['yes', 1, {}, 'true']) {
      assert.deepEqual(
        decideLoginOutcome({ ok: true, data: { mustSetPassword: v } }),
        { kind: 'error' },
      );
    }
  });

  it('is decided before the missing-api_key branch', () => {
    // The response deliberately has no api_key. If the api_key check ran first this
    // would come back as a generic error and the user would be stuck at a login form
    // that rejects the password they were given.
    const r = decideLoginOutcome({ ok: true, data: { mustSetPassword: true } });
    assert.notEqual(r.kind, 'error');
  });
});

describe('decideLoginOutcome — the existing outcomes are unchanged', () => {
  it('still routes a failed request to error', () => {
    assert.deepEqual(decideLoginOutcome({ ok: false, error: 'x' }), { kind: 'error', error: 'x' });
    assert.deepEqual(decideLoginOutcome(undefined), { kind: 'error', error: undefined });
  });

  it('still routes requiresSetup to setup', () => {
    assert.deepEqual(decideLoginOutcome({ ok: true, data: { requiresSetup: true } }), { kind: 'setup' });
    assert.deepEqual(decideLoginOutcome({ ok: true, data: { requiresSetup: 'yes' } }), { kind: 'error' });
  });

  it('still routes a key to authenticated', () => {
    const data = { api_key: 'k', id: 1, role: 'user' };
    assert.deepEqual(decideLoginOutcome({ ok: true, data }), { kind: 'authenticated', data });
  });

  it('still treats a 200 with nothing usable as an error', () => {
    assert.deepEqual(decideLoginOutcome({ ok: true, data: {} }), { kind: 'error' });
  });

  it('keeps setup ahead of the new outcome if a server ever sends both', () => {
    // Not a real server response. Pinned so the two branches cannot be reordered by
    // accident: requiresSetup means "this account has no password at all", which is a
    // different and older state than "has a temporary one".
    assert.deepEqual(
      decideLoginOutcome({ ok: true, data: { requiresSetup: true, mustSetPassword: true } }),
      { kind: 'setup' },
    );
  });
});
