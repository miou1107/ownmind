// v1.26.73 — the 系統設定 tools column groups by computer.
//
// One row per (user, tool, machine) means the same tool can appear twice for one person.
// Two lines both reading `claude-code`, different versions, no way to tell which computer
// each came from, is worse than the single row it replaced.
//
// Grouping by machine is what Vin picked from the mockup. The computer is the thing a
// person acts on: "TANK has not reported for three days" is a sentence somebody can do
// something about.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { groupClientsByMachine, osLabel } =
  await import('../client/src/pages/System/machine-groups.js');

const c = (over = {}) => ({
  tool: 'claude-code', version: '1.26.73', machine: 'Vincent.local', os: 'darwin',
  status: 'active', last_heartbeat_at: '2026-08-06T00:00:00.000Z',
  needs_upgrade: false, reason: 'ok', ...over
});

describe('grouping', () => {
  it('puts one person\'s two computers in two groups', () => {
    const g = groupClientsByMachine([
      c(), c({ tool: 'codex' }),
      c({ machine: 'TANK', os: 'win32' }), c({ tool: 'codex', machine: 'TANK', os: 'win32' })
    ]);
    assert.equal(g.length, 2);
    assert.deepEqual(g.map((x) => x.tools.length), [2, 2]);
  });

  it('keeps one computer as one group', () => {
    const g = groupClientsByMachine([c(), c({ tool: 'codex' }), c({ tool: 'cursor' })]);
    assert.equal(g.length, 1);
    assert.deepEqual(g[0].tools.map((t) => t.tool), ['claude-code', 'codex', 'cursor']);
  });

  it('survives an empty or missing list', () => {
    assert.deepEqual(groupClientsByMachine([]), []);
    assert.deepEqual(groupClientsByMachine(null), []);
    assert.deepEqual(groupClientsByMachine(undefined), []);
  });

  it('still shows a row whose machine is unknown', () => {
    // Its own status is the point. Dropping it for a missing name would lose exactly the
    // collectors worth looking at.
    const g = groupClientsByMachine([c({ machine: null, status: 'offline' })]);
    assert.equal(g.length, 1);
    assert.equal(g[0].machine, null);
    assert.equal(g[0].status, 'offline');
  });
});

describe('what a machine\'s own status is', () => {
  it('takes the worst of its tools', () => {
    // One dead collector on an otherwise busy computer is the case this change exists to
    // make visible. Averaging it away would put it straight back.
    const g = groupClientsByMachine([
      c({ tool: 'claude-code', status: 'active' }),
      c({ tool: 'codex', status: 'offline' })
    ]);
    assert.equal(g[0].status, 'offline');
  });

  it('takes the freshest heartbeat, because that is when the computer last spoke', () => {
    const g = groupClientsByMachine([
      c({ tool: 'claude-code', last_heartbeat_at: '2026-08-01T00:00:00.000Z' }),
      c({ tool: 'codex', last_heartbeat_at: '2026-08-06T00:00:00.000Z' })
    ]);
    assert.equal(g[0].last_heartbeat_at, '2026-08-06T00:00:00.000Z');
  });

  it('needs an upgrade if any of its tools does', () => {
    const g = groupClientsByMachine([
      c({ tool: 'claude-code', needs_upgrade: false }),
      c({ tool: 'codex', needs_upgrade: true })
    ]);
    assert.equal(g[0].needs_upgrade, true);
  });

  it('picks up the os from whichever row carries it', () => {
    const g = groupClientsByMachine([
      c({ tool: 'claude-code', os: null }),
      c({ tool: 'codex', os: 'darwin' })
    ]);
    assert.equal(g[0].os, 'darwin');
  });
});

describe('order', () => {
  it('puts the computer in trouble first', () => {
    // Somebody scanning this column is looking for what is broken, not for an index.
    const g = groupClientsByMachine([
      c({ machine: 'Healthy', status: 'active' }),
      c({ machine: 'Dead', status: 'offline' }),
      c({ machine: 'Slow', status: 'stale' })
    ]);
    assert.deepEqual(g.map((x) => x.machine), ['Dead', 'Slow', 'Healthy']);
  });

  it('breaks a tie with the oldest heartbeat', () => {
    const g = groupClientsByMachine([
      c({ machine: 'B', status: 'active', last_heartbeat_at: '2026-08-06T00:00:00.000Z' }),
      c({ machine: 'A', status: 'active', last_heartbeat_at: '2026-08-01T00:00:00.000Z' })
    ]);
    assert.deepEqual(g.map((x) => x.machine), ['A', 'B']);
  });

  it('is deterministic when everything else matches', () => {
    const g = groupClientsByMachine([c({ machine: 'zeta' }), c({ machine: 'alpha' })]);
    assert.deepEqual(g.map((x) => x.machine), ['alpha', 'zeta']);
  });
});

describe('os labels', () => {
  it('translates what Node reports into what a person calls it', () => {
    assert.equal(osLabel('darwin'), 'macOS');
    assert.equal(osLabel('win32'), 'Windows');
    assert.equal(osLabel('linux'), 'Linux');
  });

  it('passes an unrecognised value through rather than inventing one', () => {
    assert.equal(osLabel('freebsd'), 'freebsd');
    assert.equal(osLabel(null), null);
    assert.equal(osLabel(''), null);
  });
});

// ────────────────────────────────────────────────────────────
// The field the grouping needs from the server
// ────────────────────────────────────────────────────────────

describe('/api/usage/admin/clients carries the os', () => {
  it('selects and returns it, or the machine header has nothing to label', async () => {
    const { loadClients } = await import('../src/routes/usage/admin-clients.js');
    const seen = [];
    const query = async (sql) => {
      seen.push(sql);
      return { rows: [{
        user_id: 1, user_name: 'Vin', email: 'v@x', role: 'super_admin',
        tool: 'claude-code', scanner_version: '1.26.73', machine: 'TANK',
        os: 'win32', last_reported_at: new Date('2026-08-06T00:00:00.000Z'), reason: 'ok'
      }] };
    };
    const out = await loadClients({
      query, serverVersion: '1.26.73', now: new Date('2026-08-06T00:01:00.000Z')
    });
    assert.match(seen[0], /h\.os/, 'the query must ask for it');
    assert.equal(out.users[0].clients[0].os, 'win32', 'and the response must carry it');
  });
});
