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
    // The claim upsert returns the rows it actually claimed.
    if (sql.includes('INSERT INTO install_check_alert_state')) {
      const [user_id, machine, check_name] = params;
      return { rows: [{ user_id, machine, check_name }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO broadcast_messages')) return { rows: [{ id: 99 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { query, calls };
}

/**
 * A fake that actually keeps the state table, so the claim upsert's conflict
 * clause and the release path can be exercised across more than one run.
 * Two sweeps sharing one of these read and write the same rows, which is the
 * whole point: it is the only way to tell "claimed it" from "somebody else did".
 */
function makeStatefulDb({ reports = [ADAM_ROW], admins = [{ id: 1 }] } = {}) {
  const rows = new Map();
  const calls = [];
  const key = (userId, machine, checkName) => JSON.stringify([userId, machine, checkName]);
  let broadcastError = null;
  let nextBroadcastId = 99;
  let claimError = null;
  let claimsBeforeError = 0;
  let claimCount = 0;

  const query = async (sql, params = []) => {
    calls.push({ sql, params });

    if (sql.includes('FROM install_check_logs')) return { rows: reports, rowCount: reports.length };
    if (sql.includes('FROM install_check_alert_state')) {
      const all = [...rows.values()].map((r) => ({ ...r }));
      return { rows: all, rowCount: all.length };
    }
    if (sql.includes("role = 'super_admin'")) return { rows: admins, rowCount: admins.length };

    if (sql.includes('INSERT INTO install_check_alert_state')) {
      claimCount += 1;
      if (claimError && claimCount > claimsBeforeError) {
        const err = claimError;
        claimError = null; // the connection recovers; only this claim dies
        throw err;
      }
      const [userId, machine, checkName, detail] = params;
      const k = key(userId, machine, checkName);
      const prev = rows.get(k);
      // ON CONFLICT ... DO UPDATE ... WHERE announced_at IS NULL OR resolved_at IS NOT NULL
      if (prev && prev.announced_at && !prev.resolved_at) return { rows: [], rowCount: 0 };
      rows.set(k, {
        user_id: userId, machine, check_name: checkName, detail,
        announced_at: new Date(), resolved_at: null,
      });
      return { rows: [{ user_id: userId, machine, check_name: checkName }], rowCount: 1 };
    }

    if (sql.includes('SET announced_at = NULL')) {
      const [userId, machine, checkName] = params;
      const k = key(userId, machine, checkName);
      const prev = rows.get(k);
      if (prev) rows.set(k, { ...prev, announced_at: null });
      return { rows: [], rowCount: prev ? 1 : 0 };
    }

    if (sql.includes('INSERT INTO broadcast_messages')) {
      if (broadcastError) throw broadcastError;
      return { rows: [{ id: nextBroadcastId += 1 }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  return {
    query,
    calls,
    rows,
    breakBroadcast(err) { broadcastError = err; },
    fixBroadcast() { broadcastError = null; },
    /** Let `n` claims succeed, then throw `err` on the next one, once. */
    breakClaimAfter(n, err) { claimsBeforeError = n; claimError = err; claimCount = 0; },
  };
}

const broadcastInsert = (calls) => calls.find((c) => c.sql.includes('INSERT INTO broadcast_messages'));
const stateInserts = (calls) => calls.filter((c) => c.sql.includes('INSERT INTO install_check_alert_state'));

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

  it('picks the newest report by server-assigned id, not the client clock', async () => {
    // A machine whose clock is set to next year would otherwise upload one
    // report that outranks every later one and never announce again.
    const { query, calls } = makeQuery();
    await runInstallCheckAlerts({ query });
    const read = calls.find((c) => c.sql.includes('FROM install_check_logs'));

    assert.match(read.sql, /ORDER BY[\s\S]*l\.id DESC/);
    assert.ok(!/l\.ts DESC/.test(read.sql), 'recency must not come from the client-supplied ts');
  });

  it('keeps the alert on screen for 48 hours, not a week', async () => {
    // severity='warning' + allow_snooze=FALSE means this leads the AI's first
    // sentence in every new conversation until it expires.
    const { query, calls } = makeQuery();
    await runInstallCheckAlerts({ query });

    assert.match(broadcastInsert(calls).sql, /INTERVAL '48 hours'/);
  });
});

describe('runInstallCheckAlerts — a broadcast that never got written must not silence anything', () => {
  const poolTimeout = () => new Error('timeout exceeded when trying to connect');

  it('propagates the broadcast error instead of swallowing it', async () => {
    const db = makeStatefulDb();
    db.breakBroadcast(poolTimeout());

    await assert.rejects(
      () => runInstallCheckAlerts({ query: db.query }),
      /timeout exceeded/,
      'the caller (the route) is what decides to swallow this'
    );
  });

  it('leaves no failure marked announced when the broadcast fails', async () => {
    const db = makeStatefulDb();
    db.breakBroadcast(poolTimeout());

    await assert.rejects(() => runInstallCheckAlerts({ query: db.query }));

    const announced = [...db.rows.values()].filter((r) => r.announced_at);
    assert.deepEqual(announced, [], 'a claim outlived the broadcast it was made for');
    assert.ok(db.calls.some((c) => c.sql.includes('SET announced_at = NULL')),
      'the claim was never released');
  });

  it('releases the claims already taken when a later claim throws', async () => {
    // The claim loop is a write loop. A claim that commits and is then followed
    // by a failing claim is the same defect as a failed broadcast, one query
    // earlier: nothing was announced, yet those keys read as announced.
    const twoChecks = {
      ...ADAM_ROW,
      checks: [
        { name: 'memory_load', status: 'fail', detail: 'WSL launcher' },
        { name: 'scheduler', status: 'fail', detail: 'not registered' },
      ],
    };
    const db = makeStatefulDb({ reports: [twoChecks] });
    db.breakClaimAfter(1, poolTimeout());

    await assert.rejects(() => runInstallCheckAlerts({ query: db.query }), /timeout exceeded/);

    const announced = [...db.rows.values()].filter((r) => r.announced_at);
    assert.deepEqual(announced, [], 'the claim taken before the failure was never released');
    assert.equal(broadcastInsert(db.calls), undefined, 'nothing should have been announced');

    const second = await runInstallCheckAlerts({ query: db.query });
    assert.equal(second.announced, 2, 'the next sweep must announce both failures');

    const body = db.calls.filter((c) => c.sql.includes('INSERT INTO broadcast_messages')).pop().params[1];
    assert.ok(body.includes('memory_load'), 'the released claim is missing from the retry');
    assert.ok(body.includes('scheduler'), 'the failure that threw is missing from the retry');
  });

  it('releases only what it claimed, leaving an earlier announcement alone', async () => {
    // A key this run never claimed may belong to an announcement that really
    // happened. Clearing its announced_at would announce the same thing twice.
    const report = {
      ...ADAM_ROW,
      checks: [{ name: 'memory_load', status: 'fail', detail: 'WSL launcher' }],
    };
    const db = makeStatefulDb({ reports: [report] });
    await runInstallCheckAlerts({ query: db.query });

    report.checks.push({ name: 'scheduler', status: 'fail', detail: 'not registered' });
    report.checks.push({ name: 'hook_wiring', status: 'fail', detail: 'not installed' });
    db.breakClaimAfter(1, poolTimeout());

    await assert.rejects(() => runInstallCheckAlerts({ query: db.query }), /timeout exceeded/);

    const byCheck = new Map([...db.rows.values()].map((r) => [r.check_name, r]));
    assert.ok(byCheck.get('memory_load').announced_at,
      'an earlier, successful announcement was undone');
    assert.equal(byCheck.get('scheduler').announced_at, null,
      'the claim this run took was not released');
    assert.ok(!byCheck.has('hook_wiring'), 'the claim that threw must leave no row behind');
  });

  it('re-announces on the next sweep once the broadcast works again', async () => {
    // The failure scenario in full: the sweep marks the failure announced, the
    // broadcast insert dies, and the failure is invisible from then on.
    const db = makeStatefulDb();
    db.breakBroadcast(poolTimeout());
    await assert.rejects(() => runInstallCheckAlerts({ query: db.query }));

    db.fixBroadcast();
    const second = await runInstallCheckAlerts({ query: db.query });

    assert.equal(second.announced, 1, 'the failure was silenced by the failed run');
    assert.ok(second.broadcast_id, 'no broadcast on the retry');
  });
});

describe('runInstallCheckAlerts — two overlapping sweeps announce once between them', () => {
  it('two sweeps started together produce one broadcast between them', async () => {
    // Both sweeps read the state table before either writes to it, so both
    // compute the same new failure. Only the one that wins the claim may speak.
    const db = makeStatefulDb();

    const [first, second] = await Promise.all([
      runInstallCheckAlerts({ query: db.query }),
      runInstallCheckAlerts({ query: db.query }),
    ]);

    const broadcasts = db.calls.filter((c) => c.sql.includes('INSERT INTO broadcast_messages'));
    assert.equal(broadcasts.length, 1, 'the same failure was announced twice');
    assert.equal(first.announced + second.announced, 1, 'exactly one sweep may claim it');
    assert.equal([first.broadcast_id, second.broadcast_id].filter(Boolean).length, 1);
  });

  it('a later sweep over an already-announced failure stays silent', async () => {
    const db = makeStatefulDb();

    const first = await runInstallCheckAlerts({ query: db.query });
    const second = await runInstallCheckAlerts({ query: db.query });

    assert.equal(first.announced, 1);
    assert.ok(first.broadcast_id);
    assert.equal(second.announced, 0, 'the same failure was announced twice');
    assert.equal(second.broadcast_id, null);
  });

  it('claims each failure before the broadcast, never after', async () => {
    const { query, calls } = makeQuery();
    await runInstallCheckAlerts({ query });

    const claimAt = calls.indexOf(stateInserts(calls)[0]);
    const broadcastAt = calls.indexOf(broadcastInsert(calls));
    assert.ok(claimAt >= 0 && broadcastAt >= 0);
    assert.ok(claimAt < broadcastAt, 'the claim must be the thing that wins the race');
    assert.match(stateInserts(calls)[0].sql, /RETURNING/);
    assert.match(stateInserts(calls)[0].sql, /announced_at IS NULL/);
  });

  it('announces only the rows it actually claimed', async () => {
    // One failure is already announced and unresolved; a concurrent sweep that
    // still sees it as new must not put it in its broadcast.
    const twoChecks = {
      ...ADAM_ROW,
      checks: [
        { name: 'memory_load', status: 'fail', detail: 'WSL launcher' },
        { name: 'scheduler', status: 'fail', detail: 'not registered' },
      ],
    };
    const db = makeStatefulDb({ reports: [twoChecks] });
    await runInstallCheckAlerts({ query: db.query });

    // Re-open one key the way a resolve-then-fail-again cycle would.
    for (const [k, row] of db.rows) {
      if (row.check_name === 'scheduler') db.rows.set(k, { ...row, announced_at: null });
    }

    const again = await runInstallCheckAlerts({ query: db.query });
    assert.equal(again.announced, 1, 'only the re-opened key should be announced');

    const broadcasts = db.calls.filter((c) => c.sql.includes('INSERT INTO broadcast_messages'));
    const body = broadcasts[broadcasts.length - 1].params[1];
    assert.ok(body.includes('scheduler'), 'the claimed failure is missing from the body');
    assert.ok(!body.includes('memory_load'), 'an unclaimed failure leaked into the body');
  });
});
