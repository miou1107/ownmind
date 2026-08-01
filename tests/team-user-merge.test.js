/**
 * v1.26.49 — mergeUsersWithUsage() joins /api/admin/users with
 * /api/usage/team-stats and marks users with no usage rows as unmeasured.
 *
 * Requirement 2 in spec.md: the 用量資料 column must never render a missing
 * user as `0`. Same class of failure Stage 1a's Requirement 7 fixed for the
 * narrative payload: an LLM would confidently write "used 0 tokens" for a
 * member who never reported.
 *
 * The client uses the returned shape to render either "N tokens / M sessions"
 * or an italic "尚無資料" — no other cell.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeUsersWithUsage } from '../client/src/pages/Admin/user-merge.js';

const USERS = [
  { id: 1, email: 'a@x', name: 'Alice', role: 'super_admin', api_key: 'k1', must_change_password: false },
  { id: 2, email: 'b@x', name: 'Bob',   role: 'admin',       api_key: 'k2', must_change_password: true  },
  { id: 3, email: 'c@x', name: 'Cara',  role: 'user',        api_key: 'k3', must_change_password: false },
];

const STATS = {
  users: [
    { user: { id: 1 }, totals: { input_tokens: 20_000, output_tokens: 22_300, message_count: 18 } },
    { user: { id: 2 }, totals: { input_tokens: 10_000, output_tokens: 18_900, message_count: 12 } },
    // Cara (id 3) has no row → unmeasured
  ],
};

describe('mergeUsersWithUsage — joins on user.id', () => {
  it('produces one merged row per user, order preserved', () => {
    const rows = mergeUsersWithUsage(USERS, STATS);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
  });

  it('carries every user field through untouched', () => {
    const rows = mergeUsersWithUsage(USERS, STATS);
    assert.equal(rows[0].email, 'a@x');
    assert.equal(rows[0].name, 'Alice');
    assert.equal(rows[0].role, 'super_admin');
    assert.equal(rows[0].api_key, 'k1');
    assert.equal(rows[0].must_change_password, false);
  });

  it('a user with a stats row carries usage.total_tokens + session_count and measured=true', () => {
    const rows = mergeUsersWithUsage(USERS, STATS);
    assert.equal(rows[0].usage.measured, true);
    assert.equal(rows[0].usage.total_tokens, 42_300, 'input + output');
    assert.equal(rows[0].usage.session_count, 18);
  });

  it('a user with no stats row is measured=false, no numbers exposed', () => {
    const rows = mergeUsersWithUsage(USERS, STATS);
    const cara = rows.find((r) => r.id === 3);
    assert.equal(cara.usage.measured, false);
    assert.equal(cara.usage.total_tokens, undefined);
    assert.equal(cara.usage.session_count, undefined);
  });

  it('does not treat a stats row of all zeros as unmeasured (they DID report)', () => {
    // A member could have reported and simply not used AI this week. That is a
    // valid `0` and should render as `0`, not as unmeasured. The distinction is
    // whether their row exists at all.
    const stats = { users: [{ user: { id: 3 }, totals: { input_tokens: 0, output_tokens: 0, message_count: 0 } }] };
    const rows = mergeUsersWithUsage([USERS[2]], stats);
    assert.equal(rows[0].usage.measured, true);
    assert.equal(rows[0].usage.total_tokens, 0);
    assert.equal(rows[0].usage.session_count, 0);
  });

  it('cache tokens are excluded from the headline number', () => {
    // Cache reads are the same context re-fetched, ~250x larger than real
    // input+output. Umbrella spec Requirement 6 says the visible headline is
    // input+output only; the cache-inclusive total may appear on a second line
    // but is not this function's job.
    const stats = { users: [{ user: { id: 1 }, totals: {
      input_tokens: 100, output_tokens: 200,
      cache_creation_tokens: 999_999, cache_read_tokens: 999_999,
      message_count: 3,
    } }] };
    const rows = mergeUsersWithUsage([USERS[0]], stats);
    assert.equal(rows[0].usage.total_tokens, 300);
  });

  it('accepts a null/undefined stats payload without crashing', () => {
    // The team-stats fetch could fail while the users fetch succeeds. In that
    // case every user renders as unmeasured, not the whole page blank.
    const rows = mergeUsersWithUsage(USERS, null);
    assert.equal(rows.length, 3);
    for (const r of rows) assert.equal(r.usage.measured, false);
  });

  it('handles a stats row missing a totals sub-field gracefully', () => {
    // If a server response drops one field, treat that field as 0, not the whole
    // row as unmeasured. A partial payload is not the same as a missing user.
    const stats = { users: [{ user: { id: 1 }, totals: { input_tokens: 100 } }] };
    const rows = mergeUsersWithUsage([USERS[0]], stats);
    assert.equal(rows[0].usage.measured, true);
    assert.equal(rows[0].usage.total_tokens, 100);
    assert.equal(rows[0].usage.session_count, 0);
  });
});

describe('mergeUsersWithUsage — banner-driving counts', () => {
  it('adminCount() derived from the merged rows sums admin + super_admin', () => {
    const rows = mergeUsersWithUsage(USERS, STATS);
    // Requirement 3: banner shows when admin + super_admin ≤ 1.
    const admins = rows.filter((r) => r.role === 'admin' || r.role === 'super_admin').length;
    assert.equal(admins, 2, 'one super_admin + one admin = 2 admins total');
  });
});
