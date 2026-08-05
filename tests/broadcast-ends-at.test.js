// v1.26.62 — the end-time field of the 新增廣播 dialog moved from a text box
// holding a hand-typed ISO 8601 string to <input type="datetime-local">,
// prefilled 30 days out. That input speaks a zone-less local format, and the
// API speaks ISO 8601, so the conversion is the whole risk of the change.
//
// Every assertion here is written to hold in any timezone. A literal such as
// '2026-09-04T09:15' would pin the suite to Asia/Taipei and go red on a UTC
// runner. See openspec/changes/v1.26.62-broadcast-recipient-picker/spec.md
// Requirement 2.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultEndsAtLocal, localToIso }
  from '../client/src/pages/System/broadcast-ends-at.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('defaultEndsAtLocal', () => {
  it('returns the zone-less format the input element accepts', () => {
    const out = defaultEndsAtLocal(new Date('2026-08-05T09:15:00+08:00'));
    assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // A trailing Z or ±HH:MM makes the browser reject the value outright.
    assert.ok(!/[Z+]/.test(out.slice(10)));
  });

  it('keeps the same local time of day', () => {
    // This is the assertion that fails if the implementation goes back to
    // `now + 30 * 86400000`: that adds 720 hours, so in a zone observing
    // daylight saving the prefilled time drifts by an hour. In a zone without
    // DST both implementations agree and this simply stays green.
    const now = new Date('2026-03-01T09:15:00+08:00');
    const out = new Date(defaultEndsAtLocal(now));
    assert.equal(out.getHours(), now.getHours());
    assert.equal(out.getMinutes(), now.getMinutes());
  });

  it('lands thirty calendar days later', () => {
    const now = new Date('2026-08-05T09:15:00+08:00');
    const gap = new Date(defaultEndsAtLocal(now)).getTime() - now.getTime();
    // A range, not an equality: a DST transition legitimately makes the gap
    // 29d23h or 30d1h. Anything outside that is a unit or off-by-one-day bug.
    assert.ok(gap >= 30 * DAY_MS - 3600_000 && gap <= 30 * DAY_MS + 3600_000, `gap was ${gap}ms`);
  });

  it('pads single-digit months, days, hours and minutes', () => {
    const out = defaultEndsAtLocal(new Date('2026-08-05T09:15:00+08:00'));
    assert.equal(out.length, 16);
  });
});

describe('localToIso', () => {
  it('preserves the instant the field denotes', () => {
    const local = '2026-09-04T09:15';
    const iso = localToIso(local);
    assert.equal(new Date(iso).getTime(), new Date(local).getTime());
  });

  it('produces a string carrying an explicit offset', () => {
    const iso = localToIso('2026-09-04T09:15');
    assert.ok(/(Z|[+-]\d{2}:\d{2})$/.test(iso), `no offset in ${iso}`);
  });

  it('round-trips through defaultEndsAtLocal', () => {
    const now = new Date('2026-08-05T09:15:00+08:00');
    const gap = new Date(localToIso(defaultEndsAtLocal(now))).getTime() - now.getTime();
    assert.ok(gap >= 30 * DAY_MS - 3600_000 && gap <= 30 * DAY_MS + 3600_000, `gap was ${gap}ms`);
  });

  it('returns null for anything that does not name a moment', () => {
    // The caller uses one falsy check to mean "permanent", so every one of
    // these has to collapse to the same value.
    for (const bad of ['', '   ', null, undefined, 'not a date', '2026-13-45T99:99']) {
      assert.equal(localToIso(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});
