// v1.26.50 — observedUsers() joins /api/usage/admin/clients with
// /api/usage/team-stats to distinguish the three states the old coverage
// metric collapsed into one:
//
//   - flowing        : heartbeat present AND at least one token_usage_daily row
//                      in the window
//   - silent         : heartbeat present AND zero usage rows in the window
//                      (umbrella spec Requirement 7 — this is the hazard state
//                       the old "已裝" count hid)
//   - not_installed  : no heartbeat, ever
//   - offline        : heartbeat exists but every tool's status is 'offline'
//                      or 'unknown', regardless of usage rows
//
// A pure function so the state math is executed by tests, not read off the
// JSX. Same discipline as team-user-merge / broadcast-row-vm.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { observedUsers, rollupCounts } from '../client/src/pages/System/observed-users.js';

const CLIENTS = {
  server_version: '1.26.50',
  coverage: { total_users: 4, installed: 3 }, // legacy field, not consumed
  users: [
    {
      user_id: 1, user_name: 'Alice', email: 'a@x', role: 'super_admin',
      installed: true, any_active: true, needs_upgrade: false,
      clients: [{ tool: 'claude-code', version: '1.26.50', status: 'active',
                  last_heartbeat_at: '2026-08-01T10:00:00Z', needs_upgrade: false }],
    },
    {
      user_id: 2, user_name: 'Bob', email: 'b@x', role: 'admin',
      installed: true, any_active: true, needs_upgrade: false,
      clients: [{ tool: 'claude-code', version: '1.26.50', status: 'active',
                  last_heartbeat_at: '2026-08-01T10:00:00Z', needs_upgrade: false }],
    },
    {
      user_id: 3, user_name: 'Cara', email: 'c@x', role: 'user',
      installed: false, any_active: false, needs_upgrade: false,
      clients: [],
    },
    {
      user_id: 4, user_name: 'Dave', email: 'd@x', role: 'user',
      installed: true, any_active: false, needs_upgrade: false,
      clients: [{ tool: 'claude-code', version: '1.20.0', status: 'offline',
                  last_heartbeat_at: '2026-07-01T10:00:00Z', needs_upgrade: true }],
    },
  ],
};

const STATS = {
  users: [
    { user: { id: 1 }, totals: { input_tokens: 20_000, output_tokens: 22_300, message_count: 18 } },
    // Bob (id 2) has heartbeat but no token_usage_daily row in window → silent
    // Cara (id 3) not_installed
    // Dave (id 4) offline
  ],
};

describe('observedUsers — joins on user id', () => {
  it('returns one row per user in the clients payload', () => {
    const rows = observedUsers(CLIENTS, STATS);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => r.user_id), [1, 2, 3, 4]);
  });

  it('carries user identity fields through', () => {
    const rows = observedUsers(CLIENTS, STATS);
    assert.equal(rows[0].user_name, 'Alice');
    assert.equal(rows[0].email, 'a@x');
    assert.equal(rows[0].role, 'super_admin');
  });
});

describe('observedUsers — state classification (Requirement 7)', () => {
  it('heartbeat + usage rows → flowing', () => {
    const rows = observedUsers(CLIENTS, STATS);
    assert.equal(rows.find((r) => r.user_id === 1).state, 'flowing');
  });

  it('heartbeat + zero usage rows → silent', () => {
    // The hazard state. Old metric read this as "已裝" and the operator never
    // noticed the data pipe was silent.
    const rows = observedUsers(CLIENTS, STATS);
    assert.equal(rows.find((r) => r.user_id === 2).state, 'silent');
  });

  it('no heartbeat → not_installed regardless of usage rows', () => {
    const rows = observedUsers(CLIENTS, STATS);
    assert.equal(rows.find((r) => r.user_id === 3).state, 'not_installed');
  });

  it('installed but all tools stale/offline → offline', () => {
    const rows = observedUsers(CLIENTS, STATS);
    assert.equal(rows.find((r) => r.user_id === 4).state, 'offline');
  });

  it('a user with usage rows but no heartbeat still reads as not_installed', () => {
    // Defensive: usage rows without a heartbeat can only mean stale data or a
    // clock-skew race. The state is derived from heartbeat presence first.
    const statsWithGhost = {
      users: [
        ...STATS.users,
        { user: { id: 3 }, totals: { input_tokens: 500, output_tokens: 500, message_count: 1 } },
      ],
    };
    const rows = observedUsers(CLIENTS, statsWithGhost);
    assert.equal(rows.find((r) => r.user_id === 3).state, 'not_installed');
  });
});

describe('observedUsers — usage numbers are attached only when measured', () => {
  it('flowing row carries the token total (input + output, no cache)', () => {
    const rows = observedUsers(CLIENTS, STATS);
    const alice = rows.find((r) => r.user_id === 1);
    assert.equal(alice.usage.measured, true);
    assert.equal(alice.usage.total_tokens, 42_300);
    assert.equal(alice.usage.session_count, 18);
  });

  it('silent row: measured=false, no numbers exposed', () => {
    const rows = observedUsers(CLIENTS, STATS);
    const bob = rows.find((r) => r.user_id === 2);
    assert.equal(bob.usage.measured, false);
    assert.equal(bob.usage.total_tokens, undefined);
    assert.equal(bob.usage.session_count, undefined);
  });

  it('not_installed row: measured=false', () => {
    const rows = observedUsers(CLIENTS, STATS);
    assert.equal(rows.find((r) => r.user_id === 3).usage.measured, false);
  });
});

describe('rollupCounts — banner numbers', () => {
  it('counts each state and sums to total', () => {
    const rows = observedUsers(CLIENTS, STATS);
    const c = rollupCounts(rows);
    assert.equal(c.flowing, 1, 'Alice');
    assert.equal(c.silent, 1, 'Bob');
    assert.equal(c.not_installed, 1, 'Cara');
    assert.equal(c.offline, 1, 'Dave');
    assert.equal(c.total, 4);
    assert.equal(c.flowing + c.silent + c.not_installed + c.offline, c.total);
  });

  it('names the silent users so the operator can act on the finding', () => {
    // The banner uses these names — Requirement 7 needs a positive statement,
    // not a bare count.
    const rows = observedUsers(CLIENTS, STATS);
    const c = rollupCounts(rows);
    assert.deepEqual(c.silent_names, ['Bob']);
  });

  it('empty clients payload yields all zeros, not throws', () => {
    const rows = observedUsers({ users: [] }, { users: [] });
    const c = rollupCounts(rows);
    assert.equal(c.total, 0);
    assert.equal(c.flowing, 0);
    assert.equal(c.silent, 0);
    assert.equal(c.not_installed, 0);
    assert.equal(c.offline, 0);
    assert.deepEqual(c.silent_names, []);
  });

  it('null stats (fetch failed) is treated as "no usage anywhere" — installed users read as silent', () => {
    // When /api/usage/team-stats itself fails, we must not silently render
    // "everyone flowing". The banner conveying "we don't know" is the wrong
    // thing to hide behind an empty state.
    const rows = observedUsers(CLIENTS, null);
    const c = rollupCounts(rows);
    // 3 installed → silent, 1 not_installed → not_installed
    assert.equal(c.silent, 2, 'Alice + Bob installed but stats null');
    assert.equal(c.offline, 1, 'Dave still offline');
    assert.equal(c.not_installed, 1, 'Cara');
  });
});
