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

/**
 * Fake db: dispatches on the SQL text, records every write.
 *
 * The injected `withTransaction` stands in for the real one in `src/utils/db.js`.
 * It hands the job a client whose `query` is this same fake, and marks every call
 * made through it, so a test can tell which statements the job ran inside the
 * transaction and which it ran on its own.
 */
function makeQuery({ reports = [ADAM_ROW], state = [], admins = [{ id: 1 }] } = {}) {
  const calls = [];
  let txDepth = 0;
  const query = async (sql, params = []) => {
    calls.push({ sql, params, tx: txDepth > 0 });
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
  const withTransaction = async (fn) => {
    txDepth += 1;
    try {
      return await fn({ query });
    } finally {
      txDepth -= 1;
    }
  };
  return { query, withTransaction, calls };
}

/**
 * A fake that actually keeps the state table, so the claim upsert's conflict
 * clause and the rollback path can be exercised across more than one run.
 * Two sweeps sharing one of these read and write the same rows, which is the
 * whole point: it is the only way to tell "claimed it" from "somebody else did".
 *
 * The injected `withTransaction` snapshots the table on entry and restores it if
 * the body throws, which is what a real ROLLBACK does to the same rows.
 *
 * Caveat, for whoever writes the next test here: the restore puts back the whole
 * table, not just the rows this body wrote. A real ROLLBACK undoes only its own
 * writes, so a test that commits something from elsewhere *while* a transaction
 * is failing would get an answer this fake is not entitled to give.
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
  let txDepth = 0;

  const query = async (sql, params = []) => {
    calls.push({ sql, params, tx: txDepth > 0 });

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

    if (sql.includes('INSERT INTO broadcast_messages')) {
      if (broadcastError) throw broadcastError;
      return { rows: [{ id: nextBroadcastId += 1 }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  const withTransaction = async (fn) => {
    const snapshot = new Map([...rows].map(([k, row]) => [k, { ...row }]));
    txDepth += 1;
    try {
      return await fn({ query });
    } catch (err) {
      // ROLLBACK: every write this body made goes away, and writes committed by
      // anyone else before it started stay exactly as they were.
      rows.clear();
      for (const [k, row] of snapshot) rows.set(k, row);
      throw err;
    } finally {
      txDepth -= 1;
    }
  };

  return {
    query,
    withTransaction,
    calls,
    rows,
    breakBroadcast(err) { broadcastError = err; },
    fixBroadcast() { broadcastError = null; },
    /** Let `n` claims succeed, then throw `err` on the next one, once. */
    breakClaimAfter(n, err) { claimsBeforeError = n; claimError = err; claimCount = 0; },
  };
}

const broadcastInsert = (calls) => calls.find((c) => c.sql.includes('INSERT INTO broadcast_messages'));
const broadcastInserts = (calls) => calls.filter((c) => c.sql.includes('INSERT INTO broadcast_messages'));
const stateInserts = (calls) => calls.filter((c) => c.sql.includes('INSERT INTO install_check_alert_state'));

describe('runInstallCheckAlerts', () => {
  it('announces a new failure and returns the broadcast id', async () => {
    const { query, withTransaction, calls } = makeQuery();
    const result = await runInstallCheckAlerts({ query, withTransaction });

    assert.equal(result.announced, 1);
    assert.equal(result.broadcast_id, 99);
    assert.ok(broadcastInsert(calls), 'no broadcast was written');
  });

  it('writes the broadcast as a warning targeted at the oldest super_admin only', async () => {
    const { query, withTransaction, calls } = makeQuery({ admins: [{ id: 1 }] });
    await runInstallCheckAlerts({ query, withTransaction });

    const insert = broadcastInsert(calls);
    assert.match(insert.sql, /'warning'/);
    assert.match(insert.sql, /FALSE/); // allow_snooze
    assert.ok(insert.params.some((p) => Array.isArray(p) && p.length === 1 && p[0] === 1),
      'target_users should be exactly [1]');
  });

  it('records state so a second run is silent', async () => {
    const { query, withTransaction, calls } = makeQuery();
    await runInstallCheckAlerts({ query, withTransaction });
    const upsert = calls.find((c) => c.sql.includes('INSERT INTO install_check_alert_state'));
    assert.ok(upsert, 'state was not recorded');
    assert.match(upsert.sql, /ON CONFLICT/);
  });

  it('says nothing when every failure is already announced', async () => {
    const { query, withTransaction, calls } = makeQuery({
      state: [{
        user_id: 3, machine: 'LAPTOP-MBGGLV2J', check_name: 'memory_load',
        detail: 'bash here is the WSL launcher',
        announced_at: new Date('2026-08-06T00:00:00Z'), resolved_at: null,
      }],
    });
    const result = await runInstallCheckAlerts({ query, withTransaction });

    assert.equal(result.announced, 0);
    assert.equal(broadcastInsert(calls), undefined);
  });

  it('marks a fixed check resolved without announcing anything', async () => {
    const green = { ...ADAM_ROW, checks: [{ name: 'memory_load', status: 'pass', detail: 'loaded' }] };
    const { query, withTransaction, calls } = makeQuery({
      reports: [green],
      state: [{
        user_id: 3, machine: 'LAPTOP-MBGGLV2J', check_name: 'memory_load', detail: 'x',
        announced_at: new Date('2026-08-06T00:00:00Z'), resolved_at: null,
      }],
    });
    const result = await runInstallCheckAlerts({ query, withTransaction });

    assert.equal(result.announced, 0);
    assert.ok(calls.some((c) => c.sql.includes('SET resolved_at')), 'resolution was not recorded');
    assert.equal(broadcastInsert(calls), undefined);
  });

  it('resolves and updates details outside the transaction, so a sweep with nothing new still records them', async () => {
    // These two updates are independent of the claim-and-announce pair, and the
    // path they matter most on is the common one where no transaction is opened
    // at all: nothing new is failing, but a check just went green.
    const green = { ...ADAM_ROW, checks: [{ name: 'memory_load', status: 'pass', detail: 'loaded' }] };
    const { query, withTransaction, calls } = makeQuery({
      reports: [green],
      state: [{
        user_id: 3, machine: 'LAPTOP-MBGGLV2J', check_name: 'memory_load', detail: 'x',
        announced_at: new Date('2026-08-06T00:00:00Z'), resolved_at: null,
      }],
    });
    await runInstallCheckAlerts({ query, withTransaction });

    const resolve = calls.find((c) => c.sql.includes('SET resolved_at'));
    assert.ok(resolve, 'resolution was not recorded');
    assert.equal(resolve.tx, false, 'the resolve update does not belong to the announce transaction');
  });

  it('records state but writes no broadcast when there is no super_admin', async () => {
    const { query, withTransaction, calls } = makeQuery({ admins: [] });
    const result = await runInstallCheckAlerts({ query, withTransaction });

    assert.equal(result.broadcast_id, null);
    assert.equal(broadcastInsert(calls), undefined);
    assert.ok(calls.some((c) => c.sql.includes('INSERT INTO install_check_alert_state')));
  });

  it('keeps the claims when there is no super_admin, rather than rolling them back', async () => {
    // No recipient is not a failure. The state must still be recorded, or every
    // sweep would re-evaluate the same failures forever.
    const db = makeStatefulDb({ admins: [] });
    const result = await runInstallCheckAlerts(db);

    assert.equal(result.announced, 1);
    assert.equal(result.broadcast_id, null);
    assert.equal(db.rows.size, 1, 'the claim was not committed');
    assert.equal(broadcastInsert(db.calls), undefined);
  });

  it('only reads reports that actually carry checks', async () => {
    const { query, withTransaction, calls } = makeQuery();
    await runInstallCheckAlerts({ query, withTransaction });
    const read = calls.find((c) => c.sql.includes('FROM install_check_logs'));
    assert.match(read.sql, /jsonb_array_length/);
    assert.match(read.sql, /DISTINCT ON/);
  });

  it('picks the newest report by server-assigned id, not the client clock', async () => {
    // A machine whose clock is set to next year would otherwise upload one
    // report that outranks every later one and never announce again.
    const { query, withTransaction, calls } = makeQuery();
    await runInstallCheckAlerts({ query, withTransaction });
    const read = calls.find((c) => c.sql.includes('FROM install_check_logs'));

    assert.match(read.sql, /ORDER BY[\s\S]*l\.id DESC/);
    assert.ok(!/l\.ts DESC/.test(read.sql), 'recency must not come from the client-supplied ts');
  });

  it('keeps the alert on screen for 48 hours, not a week', async () => {
    // severity='warning' + allow_snooze=FALSE means this leads the AI's first
    // sentence in every new conversation until it expires.
    const { query, withTransaction, calls } = makeQuery();
    await runInstallCheckAlerts({ query, withTransaction });

    assert.match(broadcastInsert(calls).sql, /INTERVAL '48 hours'/);
  });
});

describe('runInstallCheckAlerts — a claim and its broadcast land together or not at all', () => {
  const poolTimeout = () => new Error('timeout exceeded when trying to connect');

  it('defaults to the real withTransaction, not to a bare query', async () => {
    // Every other test in this file injects a fake transaction, so none of them
    // can see what the job does when nobody injects one — and that is the case
    // that runs in production. Read the source, the way
    // tests/install-check-alerts-wiring.test.js checks the startup sweep: if the
    // default were swapped for something that just forwards to `query`, the whole
    // guarantee would be gone and all the green tests here would stay green.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/jobs/install-check-alerts.js', import.meta.url), 'utf8');

    assert.match(src, /import \{[^}]*withTransaction as defaultWithTransaction[^}]*\} from '\.\.\/utils\/db\.js'/,
      'the job must take the transaction helper from src/utils/db.js');
    assert.match(src, /withTransaction = defaultWithTransaction/,
      'the injectable seam must default to the real transaction');
  });

  it('claims and broadcasts inside one transaction, and a second sweep then stays silent', async () => {
    // The happy path stated as the guarantee it has to give: every write that
    // decides "this failure has been announced" is in the same transaction as
    // the announcement itself, so no failure between them can separate the two.
    const twoChecks = {
      ...ADAM_ROW,
      checks: [
        { name: 'memory_load', status: 'fail', detail: 'WSL launcher' },
        { name: 'scheduler', status: 'fail', detail: 'not registered' },
      ],
    };
    const db = makeStatefulDb({ reports: [twoChecks] });

    const first = await runInstallCheckAlerts(db);
    assert.equal(first.announced, 2);
    assert.ok(first.broadcast_id);

    const claims = stateInserts(db.calls);
    const broadcasts = broadcastInserts(db.calls);
    assert.equal(claims.length, 2, 'both failures should have been claimed');
    assert.equal(broadcasts.length, 1, 'exactly one broadcast');
    assert.ok(claims.every((c) => c.tx), 'a claim was written outside the transaction');
    assert.ok(broadcasts[0].tx, 'the broadcast was written outside the transaction');

    const body = broadcasts[0].params[1];
    assert.ok(body.includes('memory_load'), 'a claimed failure is missing from the body');
    assert.ok(body.includes('scheduler'), 'a claimed failure is missing from the body');

    const second = await runInstallCheckAlerts(db);
    assert.equal(second.announced, 0, 'the same failures were announced twice');
    assert.equal(second.broadcast_id, null);
    assert.equal(broadcastInserts(db.calls).length, 1, 'a second broadcast was written');
  });

  it('claims in a fixed order whatever order the client uploaded the checks in', async () => {
    // Each claim now holds its row lock until the transaction ends. Two sweeps
    // taking the same keys in opposite orders would deadlock, and the order used
    // to come straight from the client's `checks` array.
    const order = (calls) => stateInserts(calls).map((c) => c.params[2]);

    const forwards = makeStatefulDb({
      reports: [{
        ...ADAM_ROW,
        checks: [
          { name: 'scheduler', status: 'fail', detail: 'not registered' },
          { name: 'memory_load', status: 'fail', detail: 'WSL launcher' },
        ],
      }],
    });
    const backwards = makeStatefulDb({
      reports: [{
        ...ADAM_ROW,
        checks: [
          { name: 'memory_load', status: 'fail', detail: 'WSL launcher' },
          { name: 'scheduler', status: 'fail', detail: 'not registered' },
        ],
      }],
    });

    await runInstallCheckAlerts(forwards);
    await runInstallCheckAlerts(backwards);

    assert.deepEqual(order(forwards.calls), order(backwards.calls),
      'the lock order must not depend on what the client uploaded');
    assert.deepEqual(order(forwards.calls), ['memory_load', 'scheduler']);
  });

  it('propagates the broadcast error instead of swallowing it', async () => {
    const db = makeStatefulDb();
    db.breakBroadcast(poolTimeout());

    await assert.rejects(
      () => runInstallCheckAlerts(db),
      /timeout exceeded/,
      'the caller (the route) is what decides to swallow this'
    );
  });

  it('rolls the claims back when the broadcast throws, leaving no claimed row behind', async () => {
    const db = makeStatefulDb();
    db.breakBroadcast(poolTimeout());

    await assert.rejects(() => runInstallCheckAlerts(db));

    assert.equal(db.rows.size, 0,
      'the claim survived the transaction that failed to announce it');

    db.fixBroadcast();
    const second = await runInstallCheckAlerts(db);
    assert.equal(second.announced, 1, 'the failure was silenced by the failed run');
    assert.ok(second.broadcast_id, 'no broadcast on the retry');
  });

  it('rolls the claims back when a claim itself throws mid-loop', async () => {
    // The claim loop is a write loop. A claim that lands and is then followed by
    // a failing claim is the same defect one query earlier: nothing was
    // announced, yet that key reads as announced from then on.
    const twoChecks = {
      ...ADAM_ROW,
      checks: [
        { name: 'memory_load', status: 'fail', detail: 'WSL launcher' },
        { name: 'scheduler', status: 'fail', detail: 'not registered' },
      ],
    };
    const db = makeStatefulDb({ reports: [twoChecks] });
    db.breakClaimAfter(1, poolTimeout());

    await assert.rejects(() => runInstallCheckAlerts(db), /timeout exceeded/);

    assert.equal(db.rows.size, 0,
      'the claim taken before the failure survived the rollback');
    assert.equal(broadcastInsert(db.calls), undefined, 'nothing should have been announced');

    const second = await runInstallCheckAlerts(db);
    assert.equal(second.announced, 2, 'the next sweep must announce both failures');

    const body = broadcastInserts(db.calls).pop().params[1];
    assert.ok(body.includes('memory_load'), 'the rolled-back claim is missing from the retry');
    assert.ok(body.includes('scheduler'), 'the failure that threw is missing from the retry');
  });

  it('rolls back only its own writes, leaving an earlier announcement alone', async () => {
    // A key announced by an earlier, committed run is not this run's to undo.
    // Clearing it would announce the same problem twice.
    const report = {
      ...ADAM_ROW,
      checks: [{ name: 'memory_load', status: 'fail', detail: 'WSL launcher' }],
    };
    const db = makeStatefulDb({ reports: [report] });
    await runInstallCheckAlerts(db);

    report.checks.push({ name: 'scheduler', status: 'fail', detail: 'not registered' });
    report.checks.push({ name: 'hook_wiring', status: 'fail', detail: 'not installed' });
    db.breakClaimAfter(1, poolTimeout());

    await assert.rejects(() => runInstallCheckAlerts(db), /timeout exceeded/);

    const byCheck = new Map([...db.rows.values()].map((r) => [r.check_name, r]));
    assert.ok(byCheck.get('memory_load')?.announced_at,
      'an earlier, committed announcement was undone');
    assert.ok(!byCheck.has('scheduler'), 'the claim this run took was not rolled back');
    assert.ok(!byCheck.has('hook_wiring'), 'the claim that threw must leave no row behind');
  });
});

describe('runInstallCheckAlerts — two overlapping sweeps announce once between them', () => {
  it('two sweeps started together produce one broadcast between them', async () => {
    // Both sweeps read the state table before either writes to it, so both
    // compute the same new failure. Only the one that wins the claim may speak.
    const db = makeStatefulDb();

    const [first, second] = await Promise.all([
      runInstallCheckAlerts(db),
      runInstallCheckAlerts(db),
    ]);

    assert.equal(broadcastInserts(db.calls).length, 1, 'the same failure was announced twice');
    assert.equal(first.announced + second.announced, 1, 'exactly one sweep may claim it');
    assert.equal([first.broadcast_id, second.broadcast_id].filter(Boolean).length, 1);
  });

  it('a later sweep over an already-announced failure stays silent', async () => {
    const db = makeStatefulDb();

    const first = await runInstallCheckAlerts(db);
    const second = await runInstallCheckAlerts(db);

    assert.equal(first.announced, 1);
    assert.ok(first.broadcast_id);
    assert.equal(second.announced, 0, 'the same failure was announced twice');
    assert.equal(second.broadcast_id, null);
  });

  it('claims each failure before the broadcast, never after', async () => {
    const { query, withTransaction, calls } = makeQuery();
    await runInstallCheckAlerts({ query, withTransaction });

    const claimAt = calls.indexOf(stateInserts(calls)[0]);
    const broadcastAt = calls.indexOf(broadcastInsert(calls));
    assert.ok(claimAt >= 0 && broadcastAt >= 0);
    assert.ok(claimAt < broadcastAt, 'the claim must be the thing that wins the race');
    assert.match(stateInserts(calls)[0].sql, /RETURNING/);
    assert.match(stateInserts(calls)[0].sql, /announced_at IS NULL/);
  });

  it('re-claims a key that was resolved and has failed again', async () => {
    // The conditional upsert has to reject a second claim of a live announcement
    // and accept a claim of a key whose resolved_at is set.
    const db = makeStatefulDb();
    await runInstallCheckAlerts(db);

    for (const [k, row] of db.rows) {
      db.rows.set(k, { ...row, resolved_at: new Date() });
    }

    const again = await runInstallCheckAlerts(db);
    assert.equal(again.announced, 1, 'a failure that came back was not re-announced');
    assert.ok(again.broadcast_id);
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
    await runInstallCheckAlerts(db);

    // Re-open one key the way a resolve-then-fail-again cycle would.
    for (const [k, row] of db.rows) {
      if (row.check_name === 'scheduler') db.rows.set(k, { ...row, announced_at: null });
    }

    const again = await runInstallCheckAlerts(db);
    assert.equal(again.announced, 1, 'only the re-opened key should be announced');

    const body = broadcastInserts(db.calls).pop().params[1];
    assert.ok(body.includes('scheduler'), 'the claimed failure is missing from the body');
    assert.ok(!body.includes('memory_load'), 'an unclaimed failure leaked into the body');
  });
});
