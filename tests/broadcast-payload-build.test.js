// v1.26.62 — what the 新增廣播 dialog actually sends.
//
// Extracted from the modal's submit handler so the promise this release makes
// — the payload says what the screen says — is checked rather than eyeballed.
// The recipient ids and the end time both stop being typed and start being
// derived, and derivation is exactly where a payload quietly stops matching
// the form.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBroadcastPayload }
  from '../client/src/pages/System/broadcast-payload-build.js';

function form(overrides = {}) {
  return {
    type: 'announcement',
    severity: 'info',
    title: 'hi',
    body: 'body text',
    cta_text: '',
    allow_snooze: false,
    snooze_hours: 24,
    cooldown_minutes: 1440,
    ends_at: '',
    ...overrides,
  };
}

describe('buildBroadcastPayload — cooldown', () => {
  it('keeps an explicit zero', () => {
    // Regression. `Number(x) || 1440` turned the 0 an admin typed into 24
    // hours, because 0 is falsy — and the validator allows 0, it rejects only
    // negatives. The screen said 0 and the server was told 1440.
    assert.equal(buildBroadcastPayload(form({ cooldown_minutes: '0' }), []).cooldown_minutes, 0);
    assert.equal(buildBroadcastPayload(form({ cooldown_minutes: 0 }), []).cooldown_minutes, 0);
  });

  it('falls back to a day when the field is empty or not a number', () => {
    assert.equal(buildBroadcastPayload(form({ cooldown_minutes: '' }), []).cooldown_minutes, 1440);
    assert.equal(buildBroadcastPayload(form({ cooldown_minutes: 'abc' }), []).cooldown_minutes, 1440);
  });

  it('passes a normal value through as a number', () => {
    assert.equal(buildBroadcastPayload(form({ cooldown_minutes: '60' }), []).cooldown_minutes, 60);
  });
});

describe('buildBroadcastPayload — recipients', () => {
  it('omits the key entirely when nobody is chosen, which the server reads as everyone', () => {
    const p = buildBroadcastPayload(form(), []);
    assert.equal('target_users' in p, false);
  });

  it('sends the ids of the chosen members, in the order chosen', () => {
    const chosen = [{ id: 7, name: 'Amiee' }, { id: 4, name: 'Joanna' }];
    assert.deepEqual(buildBroadcastPayload(form(), chosen).target_users, [7, 4]);
  });
});

describe('buildBroadcastPayload — end time', () => {
  it('omits the key when the field is cleared, which means permanent', () => {
    const p = buildBroadcastPayload(form({ ends_at: '' }), []);
    assert.equal('ends_at' in p, false);
  });

  it('converts the zone-less field value to an instant', () => {
    const local = '2026-09-04T09:15';
    const p = buildBroadcastPayload(form({ ends_at: local }), []);
    assert.equal(new Date(p.ends_at).getTime(), new Date(local).getTime());
  });
});

describe('buildBroadcastPayload — text fields', () => {
  it('trims title and body', () => {
    const p = buildBroadcastPayload(form({ title: '  hi  ', body: '  there  ' }), []);
    assert.equal(p.title, 'hi');
    assert.equal(p.body, 'there');
  });

  it('omits cta_text when blank and trims it when present', () => {
    assert.equal('cta_text' in buildBroadcastPayload(form({ cta_text: '   ' }), []), false);
    assert.equal(buildBroadcastPayload(form({ cta_text: ' ok ' }), []).cta_text, 'ok');
  });

  it('carries type, severity and the snooze pair through', () => {
    const p = buildBroadcastPayload(form({ type: 'maintenance', severity: 'warning', allow_snooze: true, snooze_hours: '6' }), []);
    assert.equal(p.type, 'maintenance');
    assert.equal(p.severity, 'warning');
    assert.equal(p.allow_snooze, true);
    assert.equal(p.snooze_hours, 6);
  });
});
