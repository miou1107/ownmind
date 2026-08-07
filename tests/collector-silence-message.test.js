import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderMemberMessage, renderAdminMessage } from '../src/lib/collector-silence-message.js';
import { DELIVERY_MAX_CHARS, DELIVERY_MAX_LINES } from '../src/lib/broadcast-envelope.js';

/**
 * v1.26.99 — two audiences, two messages.
 *
 * The delivery path shows the first five lines joined by a space, cut at 400
 * characters. Anything past that never reaches the reader, so these assert the
 * text as delivered, not as stored.
 */

/** What the delivery path actually puts in front of a reader. */
function asDelivered(body) {
  return body.split('\n').slice(0, DELIVERY_MAX_LINES).join(' ').slice(0, DELIVERY_MAX_CHARS);
}

function silence(over = {}) {
  return {
    user_id: 2,
    user_name: 'Amiee Kuo',
    machine: 'LAPTOP-RGE2HCSQ',
    stale_tools: 'antigravity,cursor,opencode',
    last_beat_at: new Date('2026-07-27T01:18:00Z'),
    stale_days: 11,
    ...over,
  };
}

describe('v1.26.99 — the message the person gets', () => {
  const { title, body } = renderMemberMessage([silence()]);

  it('is addressed to them, about their own machine', () => {
    assert.equal(title, '你的用量採集停了');
    assert.match(body, /LAPTOP-RGE2HCSQ/);
    // Their own name would be odd in a message they are reading about themselves.
    assert.ok(!body.includes('Amiee'));
  });

  it('says which tools stopped and when', () => {
    assert.match(body, /antigravity、cursor、opencode/);
    assert.match(body, /07\/27/);
    assert.match(body, /11 天/);
  });

  it('says what it cost them, not only that a program stopped', () => {
    // "your scanner is dead" is a fact about software. "your usage was not
    // uploaded" is the reason they should care enough to act.
    assert.match(body, /用量沒有上傳/);
  });

  it('carries a repair that exists on every client, including old ones', () => {
    assert.match(body, /修法/);
    // Not the ensure-scanner-schedule.sh path: it ships from v1.26.79 onward,
    // and a machine frozen for weeks is exactly the one that never received it.
    assert.ok(!body.includes('ensure-scanner-schedule'));
  });

  it('fits the delivery envelope', () => {
    assert.ok(asDelivered(body).length <= DELIVERY_MAX_CHARS);
  });

  it('a machine name with newlines cannot spend another entry\'s line', () => {
    // The same untrusted hostname reaches both renderers; only the admin one was
    // covered, so removing oneLine() here changed nothing any test could see.
    const { body: two } = renderMemberMessage([
      silence({ machine: 'evil\nname\nhere' }),
      silence({ machine: 'BOX-B', stale_days: 3 }),
    ]);
    assert.equal(two.split('\n').length, 2);
    assert.match(two, /BOX-B/);
  });

  it('puts the longest silence first, so truncation drops the newest problems', () => {
    const { body: many } = renderMemberMessage([
      silence({ machine: 'RECENT', stale_days: 8 }),
      silence({ machine: 'ANCIENT', stale_days: 40 }),
    ]);
    assert.ok(many.indexOf('ANCIENT') < many.indexOf('RECENT'));
  });
});

describe('v1.26.99 — the message the admin gets', () => {
  const many = [
    silence({ user_id: 2, user_name: 'Amiee Kuo', machine: 'A', stale_days: 11 }),
    silence({ user_id: 3, user_name: 'Adam', machine: 'B', stale_days: 40 }),
  ];
  const { title, body } = renderAdminMessage(many);

  it('counts the machines in the title', () => {
    assert.equal(title, '2 台機器的用量採集停了');
  });

  it('names who each machine belongs to', () => {
    assert.match(body, /Amiee Kuo（A）/);
    assert.match(body, /Adam（B）/);
  });

  it('puts the longest silence first, so truncation drops the newest problems', () => {
    assert.ok(body.indexOf('Adam') < body.indexOf('Amiee'));
  });

  it('says why the dashboard still looks fine', () => {
    // Without this the reader checks the panel, sees a recent heartbeat, and
    // concludes the alert is wrong. That heartbeat is the whole defect.
    assert.match(body, /還在回報/);
  });

  it('does not tell the admin to run a repair they cannot run', () => {
    assert.ok(!body.includes('修法'));
  });

  it('falls back to the user id when the account has no name', () => {
    const { body: anon } = renderAdminMessage([silence({ user_name: '', user_id: 42 })]);
    assert.match(anon, /user 42/);
  });
});

describe('v1.26.99 — more machines than fit', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => silence({
    user_id: i + 1, user_name: `Person ${i}`, machine: `MACHINE-${i}`, stale_days: 30 - i,
  }));
  const { body, omitted } = renderAdminMessage(twelve);

  it('says how many were left out rather than stopping silently', () => {
    assert.equal(omitted, 12 - (DELIVERY_MAX_LINES - 1));
    assert.match(asDelivered(body), /另有 8 項未列出，總共 12 項/);
  });

  it('the sentence saying so survives delivery', () => {
    // It is the last line on purpose: the transform keeps the first five, so a
    // footer written anywhere else is the part that gets cut.
    assert.ok(asDelivered(body).includes('總共 12 項'));
  });

  it('still fits', () => {
    assert.ok(asDelivered(body).length <= DELIVERY_MAX_CHARS);
  });
});

describe('v1.26.99 — dates and rubbish', () => {
  it('renders the date in Asia/Taipei, not UTC', () => {
    // 2026-07-27T16:30Z is already the 28th in Taipei. A date silently one day
    // behind is what makes a reader distrust the rest of the message.
    const { body } = renderMemberMessage([silence({ last_beat_at: new Date('2026-07-27T16:30:00Z') })]);
    assert.match(body, /07\/28/);
  });

  it('says so rather than printing Invalid Date', () => {
    const { body } = renderMemberMessage([silence({ last_beat_at: 'nonsense' })]);
    assert.match(body, /不明/);
    assert.ok(!body.includes('Invalid'));
  });

  it('a machine name with newlines cannot spend another entry\'s line', () => {
    const { body } = renderAdminMessage([
      silence({ machine: 'evil\nname\nhere' }),
      silence({ user_id: 9, user_name: 'Second', machine: 'B' }),
    ]);
    assert.equal(body.split('\n').length, 2);
    assert.match(body, /Second/);
  });

  it('nothing to say produces an empty body', () => {
    assert.equal(renderAdminMessage([]).body, '');
    assert.equal(renderMemberMessage([]).body, '');
  });
});
