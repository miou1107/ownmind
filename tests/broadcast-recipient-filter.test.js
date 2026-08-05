// v1.26.62 — the suggestion filter behind the 新增廣播 recipient picker.
// Kept as a pure function so the behaviour that decides *who the admin can
// pick* is testable without a browser. The picker replaces a free-text
// user_id box (see openspec/changes/v1.26.62-broadcast-recipient-picker/),
// which is why "already selected drops out" matters: a member appearing
// twice in the menu is how duplicate ids used to reach the payload.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterMembers }
  from '../client/src/pages/System/broadcast-recipient-filter.js';

const USERS = [
  { id: 1, name: 'Vin', email: 'vincent@fontrip.com' },
  { id: 4, name: 'Joanna', email: 'joanna@fontrip.com' },
  { id: 7, name: 'Amiee Kuo', email: 'amiee@fontrip.com' },
];

describe('filterMembers', () => {
  it('matches on name', () => {
    const hits = filterMembers(USERS, 'jo', []);
    assert.deepEqual(hits.map((u) => u.id), [4]);
  });

  it('matches on email, case-insensitively', () => {
    // 'VINCENT@' appears only in the email, and only in lower case there,
    // so this fails unless both sides are folded and email is searched.
    const hits = filterMembers(USERS, 'VINCENT@', []);
    assert.deepEqual(hits.map((u) => u.id), [1]);
  });

  it('drops members that are already selected', () => {
    const hits = filterMembers(USERS, '', [4]);
    assert.deepEqual(hits.map((u) => u.id), [1, 7]);
  });

  it('returns everyone unselected for an empty or blank query', () => {
    assert.deepEqual(filterMembers(USERS, '', []).map((u) => u.id), [1, 4, 7]);
    assert.deepEqual(filterMembers(USERS, '   ', []).map((u) => u.id), [1, 4, 7]);
  });

  it('preserves the input order rather than match order', () => {
    // 'o' hits all three: Vin through 'fontrip', Joanna and Kuo through name.
    // The menu must list them the way the API returned them.
    assert.deepEqual(filterMembers(USERS, 'o', []).map((u) => u.id), [1, 4, 7]);
  });

  it('returns an empty array when nothing matches', () => {
    const hits = filterMembers(USERS, 'zzz', []);
    assert.ok(Array.isArray(hits));
    assert.equal(hits.length, 0);
  });

  it('returns an empty array instead of throwing when the list is not there', () => {
    // The modal renders once before the fetch resolves, so this is a real
    // call, not a defensive hypothetical.
    for (const bad of [null, undefined, 'nope', 42, {}]) {
      const hits = filterMembers(bad, 'jo', []);
      assert.ok(Array.isArray(hits));
      assert.equal(hits.length, 0);
    }
  });

  it('tolerates a member row with no name or no email', () => {
    const partial = [{ id: 2, name: null, email: 'ghost@fontrip.com' }, { id: 3, email: null, name: 'Nameless' }];
    assert.deepEqual(filterMembers(partial, 'ghost', []).map((u) => u.id), [2]);
    assert.deepEqual(filterMembers(partial, 'nameless', []).map((u) => u.id), [3]);
  });
});
