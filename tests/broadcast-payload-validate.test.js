// v1.26.50 — the client-side validator for POST /broadcast/admin. Mirrors
// the server's validateBroadcastPayload (src/routes/broadcast.js) so an
// invalid submit is refused before hitting the network. Server keeps its own
// check for defence in depth; this one exists so the UX is not "send request,
// wait for round trip, render error".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBroadcastFormClient }
  from '../client/src/pages/System/broadcast-payload-validate.js';

function payload(overrides = {}) {
  return {
    type: 'announcement',
    severity: 'info',
    title: 'hi',
    body: 'body text',
    allow_snooze: false,
    snooze_hours: 24,
    cooldown_minutes: 1440,
    ends_at: '',
    target_users: '',
    ...overrides,
  };
}

describe('validateBroadcastFormClient — valid input returns null', () => {
  it('minimal valid payload passes', () => {
    assert.equal(validateBroadcastFormClient(payload()), null);
  });

  it('with allow_snooze on and a positive hour count', () => {
    assert.equal(validateBroadcastFormClient(payload({ allow_snooze: true, snooze_hours: 48 })), null);
  });

  it('with a valid ends_at ISO string', () => {
    assert.equal(validateBroadcastFormClient(payload({ ends_at: '2026-12-31T00:00:00Z' })), null);
  });

  it('with target_users as a comma-separated list of positive integers', () => {
    assert.equal(validateBroadcastFormClient(payload({ target_users: '1, 2, 3' })), null);
  });
});

describe('validateBroadcastFormClient — invalid input returns a key', () => {
  it('title missing', () => {
    assert.equal(validateBroadcastFormClient(payload({ title: '' })), 'title_required');
  });

  it('title over 200 chars', () => {
    assert.equal(
      validateBroadcastFormClient(payload({ title: 'x'.repeat(201) })),
      'title_too_long',
    );
  });

  it('body missing', () => {
    assert.equal(validateBroadcastFormClient(payload({ body: '' })), 'body_required');
  });

  it('body over 2000 chars', () => {
    assert.equal(
      validateBroadcastFormClient(payload({ body: 'x'.repeat(2001) })),
      'body_too_long',
    );
  });

  it('type outside the known vocabulary', () => {
    assert.equal(validateBroadcastFormClient(payload({ type: 'ghost' })), 'type_invalid');
  });

  it('severity outside the known vocabulary', () => {
    assert.equal(validateBroadcastFormClient(payload({ severity: 'meh' })), 'severity_invalid');
  });

  it('snooze_hours zero when allow_snooze is on', () => {
    assert.equal(
      validateBroadcastFormClient(payload({ allow_snooze: true, snooze_hours: 0 })),
      'snooze_hours_invalid',
    );
  });

  it('snooze_hours negative when allow_snooze is on', () => {
    assert.equal(
      validateBroadcastFormClient(payload({ allow_snooze: true, snooze_hours: -1 })),
      'snooze_hours_invalid',
    );
  });

  it('cooldown_minutes negative', () => {
    assert.equal(
      validateBroadcastFormClient(payload({ cooldown_minutes: -5 })),
      'cooldown_minutes_invalid',
    );
  });

  it('ends_at that does not parse', () => {
    assert.equal(
      validateBroadcastFormClient(payload({ ends_at: 'not a date' })),
      'ends_at_invalid',
    );
  });

  it('target_users containing a non-integer', () => {
    assert.equal(
      validateBroadcastFormClient(payload({ target_users: '1, foo, 3' })),
      'target_users_invalid',
    );
  });

  it('target_users containing zero or negative', () => {
    assert.equal(
      validateBroadcastFormClient(payload({ target_users: '1, 0, 3' })),
      'target_users_invalid',
    );
  });
});
