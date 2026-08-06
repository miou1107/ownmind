// tests/install-check-alerts-job.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runInstallCheckAlerts } from '../src/jobs/install-check-alerts.js';

const ADAM_ROW = {
  user_id: 3,
  user_name: 'Adam',
  machine: 'LAPTOP-MBGGLV2J',
  client_version: '1.26.84',
  checks: [
    { name: 'scheduler', status: 'pass', detail: 'Task Scheduler state=Ready' },
    { name: 'memory_load', status: 'fail', detail: 'bash here is the WSL launcher', fix: 'Re-run the installer' },
  ],
};

/** Fake db: dispatches on the SQL text, records every write. */
function makeQuery({ reports = [ADAM_ROW], state = [], admins = [{ id: 1 }] } = {}) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM install_check_logs')) return { rows: reports, rowCount: reports.length };
    if (sql.includes('FROM install_check_alert_state')) return { rows: state, rowCount: state.length };
    if (sql.includes("role='super_admin'") || sql.includes("role = 'super_admin'")) {
      return { rows: admins, rowCount: admins.length };
    }
    if (sql.includes('INSERT INTO broadcast_messages')) return { rows: [{ id: 99 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { query, calls };
}

const broadcastInsert = (calls) => calls.find((c) => c.sql.includes('INSERT INTO broadcast_messages'));

describe('runInstallCheckAlerts', () => {
  it('announces a new failure and returns the broadcast id', async () => {
    const { query, calls } = makeQuery();
    const result = await runInstallCheckAlerts({ query });

    assert.equal(result.announced, 1);
    assert.equal(result.broadcast_id, 99);
    assert.ok(broadcastInsert(calls), 'no broadcast was written');
  });

  it('writes the broadcast as a warning targeted at the oldest super_admin only', async () => {
    const { query, calls } = makeQuery({ admins: [{ id: 1 }] });
    await runInstallCheckAlerts({ query });

    const insert = broadcastInsert(calls);
    assert.match(insert.sql, /'warning'/);
    assert.match(insert.sql, /FALSE/); // allow_snooze
    assert.ok(insert.params.some((p) => Array.isArray(p) && p.length === 1 && p[0] === 1),
      'target_users should be exactly [1]');
  });

  it('records state so a second run is silent', async () => {
    const { query, calls } = makeQuery();
    await runInstallCheckAlerts({ query });
    const upsert = calls.find((c) => c.sql.includes('INSERT INTO install_check_alert_state'));
    assert.ok(upsert, 'state was not recorded');
    assert.match(upsert.sql, /ON CONFLICT/);
  });

  it('says nothing when every failure is already announced', async () => {
    const { query, calls } = makeQuery({
      state: [{
        user_id: 3, machine: 'LAPTOP-MBGGLV2J', check_name: 'memory_load',
        detail: 'bash here is the WSL launcher',
        announced_at: new Date('2026-08-06T00:00:00Z'), resolved_at: null,
      }],
    });
    const result = await runInstallCheckAlerts({ query });

    assert.equal(result.announced, 0);
    assert.equal(broadcastInsert(calls), undefined);
  });

  it('marks a fixed check resolved without announcing anything', async () => {
    const green = { ...ADAM_ROW, checks: [{ name: 'memory_load', status: 'pass', detail: 'loaded' }] };
    const { query, calls } = makeQuery({
      reports: [green],
      state: [{
        user_id: 3, machine: 'LAPTOP-MBGGLV2J', check_name: 'memory_load', detail: 'x',
        announced_at: new Date('2026-08-06T00:00:00Z'), resolved_at: null,
      }],
    });
    const result = await runInstallCheckAlerts({ query });

    assert.equal(result.announced, 0);
    assert.ok(calls.some((c) => c.sql.includes('SET resolved_at')), 'resolution was not recorded');
    assert.equal(broadcastInsert(calls), undefined);
  });

  it('records state but writes no broadcast when there is no super_admin', async () => {
    const { query, calls } = makeQuery({ admins: [] });
    const result = await runInstallCheckAlerts({ query });

    assert.equal(result.broadcast_id, null);
    assert.equal(broadcastInsert(calls), undefined);
    assert.ok(calls.some((c) => c.sql.includes('INSERT INTO install_check_alert_state')));
  });

  it('only reads reports that actually carry checks', async () => {
    const { query, calls } = makeQuery();
    await runInstallCheckAlerts({ query });
    const read = calls.find((c) => c.sql.includes('FROM install_check_logs'));
    assert.match(read.sql, /jsonb_array_length/);
    assert.match(read.sql, /DISTINCT ON/);
  });
});
