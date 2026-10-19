// tests/collector-silence-job.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  runCollectorSilenceAlerts, CONFIRM_HOURS, REANNOUNCE_DAYS,
} from '../src/jobs/collector-silence-alerts.js';

const NOW = new Date('2026-08-07T07:10:00Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/**
 * A heartbeat row `days` old **relative to the sweep's clock**, not to a fixed
 * moment. Several tests advance the clock between sweeps, and a fixture pinned to
 * a constant would quietly age into a machine that is entirely dark — which this
 * feature deliberately does not report, so the test would pass for the wrong
 * reason or fail for an invented one.
 */
function beat(now, user_id, user_name, machine, tool, days) {
  return { user_id, user_name, machine, tool, last_reported_at: new Date(now.getTime() - days * DAY) };
}

/** One broken machine: the MCP's tool beating, the scanner's tools frozen. */
const BROKEN = (now) => [
  beat(now, 2, 'member-1', 'LAPTOP-MEMBER1', 'claude-code', 0.2),
  beat(now, 2, 'member-1', 'LAPTOP-MEMBER1', 'cursor', 11.2),
  beat(now, 2, 'member-1', 'LAPTOP-MEMBER1', 'opencode', 11.2),
];

const HEALTHY = (now) => ['claude-code', 'cursor', 'opencode']
  .map((tool) => beat(now, 7, 'Vincent Kao', 'Vincent.local', tool, 0.1));

/** Every tool on one machine beating again. */
const repairedTools = (now, machine, tools = ['claude-code', 'cursor', 'opencode']) =>
  tools.map((tool) => beat(now, 2, 'member-1', machine, tool, 0.1));

/** Two machines belonging to one person, both broken, one worse. */
const TWO_MACHINES = (now) => [
  beat(now, 2, 'member-1', 'BOX-A', 'claude-code', 0.2),
  beat(now, 2, 'member-1', 'BOX-A', 'cursor', 11),
  beat(now, 2, 'member-1', 'BOX-B', 'claude-code', 0.2),
  beat(now, 2, 'member-1', 'BOX-B', 'cursor', 20),
];

/**
 * A fake database that keeps the state table, so a sweep can be run more than
 * once against what the previous one wrote.
 *
 * It interprets the real statements' semantics — the confirmation window, the
 * claim's WHERE, the guard on ending a shared broadcast — which means those
 * rules exist in two places: here, and in the SQL. Tests written against it
 * therefore prove the two agree, not that the SQL is right. The suite below
 * reads the statements as well, and the semantics were run once against the real
 * database; both are recorded in the change folder.
 *
 * `withTransaction` snapshots the table on entry and restores it if the body
 * throws, which is what a real ROLLBACK does to the same rows. The restore puts
 * back the whole table, not only the rows the body wrote.
 */
function makeDb({ beats = BROKEN, admins = [{ id: 1 }], clock = () => NOW } = {}) {
  const rows = new Map();
  const broadcasts = new Map();
  const calls = [];
  const key = (userId, machine) => JSON.stringify([userId, machine]);
  let nextBroadcastId = 500;
  let txDepth = 0;
  let failForUser = null;
  let failEverything = null;

  // Read from the module under test, not restated. When these were two copies of
  // the same numbers, setting CONFIRM_HOURS to 0 in the source changed nothing
  // any test could see — the fake went on enforcing the old window on its own.
  // The values themselves are pinned by the properties asserted further down.
  const CONFIRM_MS = CONFIRM_HOURS * HOUR;
  const REANNOUNCE_MS = REANNOUNCE_DAYS * DAY;

  const query = async (sql, params = []) => {
    calls.push({ sql, params, tx: txDepth > 0 });
    const now = clock();

    if (sql.includes('FROM collector_heartbeat')) {
      const current = beats(now);
      return { rows: current, rowCount: current.length };
    }

    // Matched on the statement's opening verb, not on a table name appearing
    // anywhere in it. The DELETE and the end-broadcast UPDATE both mention this
    // table too, and a looser test answered them with the state list instead of
    // running them — silently, for four tests.
    if (sql.trimStart().startsWith('\n  SELECT user_id, machine, stale_tools')
        || /^\s*SELECT user_id, machine, stale_tools/.test(sql)) {
      const all = [...rows.values()].map((r) => ({ ...r }));
      return { rows: all, rowCount: all.length };
    }

    if (sql.includes("role = 'super_admin'")) return { rows: admins, rowCount: admins.length };

    // SIGHTING_SQL — record, never announce.
    if (sql.includes('INSERT INTO collector_silence_alert_state')) {
      const [user_id, machine, stale_tools, last_beat_at] = params;
      const k = key(user_id, machine);
      const prev = rows.get(k);
      if (!prev) {
        rows.set(k, {
          user_id, machine, stale_tools, last_beat_at,
          first_seen_at: now, announced_at: null, resolved_at: null, broadcast_id: null,
        });
      } else {
        const wasResolved = prev.resolved_at !== null;
        Object.assign(prev, {
          stale_tools,
          last_beat_at,
          first_seen_at: wasResolved ? now : prev.first_seen_at,
          announced_at: wasResolved ? null : prev.announced_at,
          broadcast_id: wasResolved ? null : prev.broadcast_id,
          resolved_at: null,
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (/^\s*DELETE FROM collector_silence_alert_state/.test(sql)) {
      const row = rows.get(key(params[0], params[1]));
      if (row && row.announced_at === null) rows.delete(key(params[0], params[1]));
      return { rows: [], rowCount: 1 };
    }

    if (/^\s*UPDATE collector_silence_alert_state/.test(sql)) {
      const row = rows.get(key(params[0], params[1]));
      if (!row) return { rows: [], rowCount: 0 };

      if (sql.includes('SET announced_at = NOW()')) {           // CLAIM_SQL
        // v1.32.15 — $3 (rerun_at), when given, must be after the sighting. NULL means
        // time alone confirms. `undefined` is not NULL here: a job that stopped passing
        // the parameter has to show up as a failure, not as the time-only rule.
        const rerunAt = params[2];
        const reran = rerunAt === null
          || (rerunAt !== undefined && new Date(rerunAt).getTime() > row.first_seen_at.getTime());
        const confirmed = now.getTime() - row.first_seen_at.getTime() >= CONFIRM_MS && reran;
        const dueAgain = row.announced_at !== null
          && now.getTime() - row.announced_at.getTime() >= REANNOUNCE_MS;
        if (row.resolved_at !== null || !confirmed) return { rows: [], rowCount: 0 };
        if (row.announced_at !== null && !dueAgain) return { rows: [], rowCount: 0 };
        row.announced_at = now;
        row.broadcast_id = null;
        return { rows: [{ user_id: row.user_id, machine: row.machine }], rowCount: 1 };
      }
      if (sql.includes('SET resolved_at = NOW()')) {
        row.resolved_at = now;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SET broadcast_id = $3')) {
        row.broadcast_id = params[2];
        return { rows: [], rowCount: 1 };
      }
    }

    if (sql.includes('INSERT INTO broadcast_messages')) {
      if (failEverything) throw failEverything;
      if (failForUser !== null && params[2]?.[0] === failForUser) {
        throw new Error(`broadcast insert exploded for user ${failForUser}`);
      }
      const id = nextBroadcastId++;
      broadcasts.set(id, { id, title: params[0], body: params[1], target_users: params[2], created_by: params[3], ends_at: 'future' });
      return { rows: [{ id }], rowCount: 1 };
    }

    // END_BROADCAST_SQL — only once nothing else it covers is still unresolved.
    if (/^\s*UPDATE broadcast_messages/.test(sql)) {
      const [broadcastId, userId, machine] = params;
      const othersOpen = [...rows.values()].some((r) => (
        r.broadcast_id === broadcastId && r.resolved_at === null
        && !(r.user_id === userId && r.machine === machine)
      ));
      const bc = broadcasts.get(broadcastId);
      if (bc && !othersOpen) bc.ends_at = 'ended';
      return { rows: [], rowCount: bc && !othersOpen ? 1 : 0 };
    }

    return { rows: [], rowCount: 0 };
  };

  const withTransaction = async (fn) => {
    const snapshot = new Map([...rows].map(([k, v]) => [k, { ...v }]));
    txDepth += 1;
    try {
      return await fn({ query });
    } catch (err) {
      rows.clear();
      for (const [k, v] of snapshot) rows.set(k, v);
      throw err;
    } finally {
      txDepth -= 1;
    }
  };

  return {
    query, withTransaction, calls, rows, broadcasts,
    failBroadcasts: (err) => { failEverything = err; },
    failBroadcastsFor: (userId) => { failForUser = userId; },
  };
}

/** A clock that can be moved on, since announcing now depends on elapsed time. */
function movableClock(start = NOW) {
  let at = start;
  const now = () => at;
  now.advance = (ms) => { at = new Date(at.getTime() + ms); };
  return now;
}

describe('v1.26.102 — nothing is announced on first sighting', () => {
  it('records the machine and tells nobody', async () => {
    // A computer switched back on after a fortnight away shows one fresh MCP row
    // against several stale scanner ones until the scanner's next run — two hours
    // on Windows, longer on battery. Announcing on sight would send an
    // un-snoozeable two-day notice about a machine that is fine.
    const db = makeDb();
    const out = await runCollectorSilenceAlerts({ ...db, now: () => NOW });

    assert.equal(out.seen, 1);
    assert.equal(out.announced, 0);
    assert.equal(db.broadcasts.size, 0);
    assert.equal(db.rows.size, 1, 'the sighting was not recorded, so it can never be confirmed');
  });

  it('announces on a later sweep, once the window has passed', async () => {
    const clock = movableClock();
    const db = makeDb({ clock });
    await runCollectorSilenceAlerts({ ...db, now: clock });
    clock.advance((CONFIRM_HOURS + 1) * HOUR);
    const out = await runCollectorSilenceAlerts({ ...db, now: clock });

    assert.equal(out.announced, 1);
    assert.equal(db.broadcasts.size, 2);
  });

  it('a machine that healed before it was confirmed leaves no record behind', async () => {
    // Otherwise its stale first_seen_at would let the next break announce
    // immediately, skipping the window this machine was never observed through.
    const clock = movableClock();
    const db = makeDb({ clock });
    await runCollectorSilenceAlerts({ ...db, now: clock });
    assert.equal(db.rows.size, 1);

    const repaired = makeDb({ beats: (now) => repairedTools(now, 'LAPTOP-MEMBER1'), clock });
    for (const [k, v] of db.rows) repaired.rows.set(k, v);
    clock.advance(HOUR);
    await runCollectorSilenceAlerts({ ...repaired, now: clock });

    assert.equal(repaired.rows.size, 0, 'the unconfirmed sighting outlived the problem');
  });
});

describe('v1.26.102 — the job announces a dead collector', () => {
  /** Sweep once to record, advance past the window, sweep again to announce. */
  async function announceOnce(db, clock) {
    await runCollectorSilenceAlerts({ ...db, now: clock });
    clock.advance((CONFIRM_HOURS + 1) * HOUR);
    return runCollectorSilenceAlerts({ ...db, now: clock });
  }

  it('writes one message to the person and one to the admin', async () => {
    const clock = movableClock();
    const db = makeDb({ clock });
    const out = await announceOnce(db, clock);

    assert.equal(out.announced, 1);
    assert.equal(out.broadcast_ids.length, 2);

    const sent = [...db.broadcasts.values()];
    const member = sent.find((b) => b.target_users[0] === 2);
    const adminCopy = sent.find((b) => b.target_users[0] === 1);
    assert.ok(member, 'the person whose machine it is was not told');
    assert.ok(adminCopy, 'the admin was not told');
    assert.equal(member.title, '你的用量採集停了');
    assert.match(adminCopy.title, /1 台機器/);
  });

  it('attributes the member\'s message to the system, not to its recipient', async () => {
    const clock = movableClock();
    const db = makeDb({ clock });
    await announceOnce(db, clock);
    const member = [...db.broadcasts.values()].find((b) => b.target_users[0] === 2);
    assert.equal(member.created_by, 1, 'the message reads as though they sent it to themselves');
  });

  it('says nothing at all when every machine is healthy', async () => {
    const db = makeDb({ beats: HEALTHY });
    const out = await runCollectorSilenceAlerts({ ...db, now: () => NOW });
    assert.equal(out.seen, 0);
    assert.equal(db.broadcasts.size, 0);
    // Not merely "no broadcast": no transaction should have been opened either.
    assert.equal(db.calls.some((c) => c.tx), false);
  });

  it('keeps the record current as a silence widens, without announcing again', async () => {
    // The path that used to have its own UPDATE statement and no test at all: a
    // swapped parameter pair there would have thrown on every sweep, before
    // anything was announced, for as long as any silence was widening.
    const clock = movableClock();
    const db = makeDb({ clock });
    await announceOnce(db, clock);
    const before = db.broadcasts.size;

    const wider = makeDb({
      beats: (now) => [...BROKEN(now), beat(now, 2, 'member-1', 'LAPTOP-MEMBER1', 'antigravity', 11.2)],
      clock,
    });
    for (const [k, v] of db.rows) wider.rows.set(k, v);
    clock.advance(DAY);
    const out = await runCollectorSilenceAlerts({ ...wider, now: clock });

    assert.equal(out.announced, 0);
    assert.equal(wider.broadcasts.size, 0, 'a widening silence announced itself again');
    assert.equal([...wider.rows.values()][0].stale_tools, 'antigravity,cursor,opencode');
    assert.equal(before, 2);
  });
});

describe('v1.26.102 — running it again', () => {
  it('a sweep the next day announces nothing', async () => {
    const clock = movableClock();
    const db = makeDb({ clock });
    await runCollectorSilenceAlerts({ ...db, now: clock });
    clock.advance((CONFIRM_HOURS + 1) * HOUR);
    const announced = await runCollectorSilenceAlerts({ ...db, now: clock });
    clock.advance(DAY);
    const again = await runCollectorSilenceAlerts({ ...db, now: clock });

    assert.equal(announced.announced, 1);
    assert.equal(again.announced, 0);
    assert.equal(db.broadcasts.size, 2, 'a later sweep wrote more broadcasts');
  });

  it('mentions a machine still broken a fortnight later', async () => {
    // The broadcast expires after 48 hours. Without this the machine is never
    // raised again, which is the state this feature was built to end.
    const clock = movableClock();
    const db = makeDb({ clock });
    await runCollectorSilenceAlerts({ ...db, now: clock });
    clock.advance((CONFIRM_HOURS + 1) * HOUR);
    await runCollectorSilenceAlerts({ ...db, now: clock });

    clock.advance((REANNOUNCE_DAYS - 1) * DAY);
    assert.equal((await runCollectorSilenceAlerts({ ...db, now: clock })).announced, 0);
    clock.advance(2 * DAY);
    assert.equal((await runCollectorSilenceAlerts({ ...db, now: clock })).announced, 1);
  });
});

describe('v1.26.102 — recovery', () => {
  async function announced(clock, beats = BROKEN) {
    const db = makeDb({ beats, clock });
    await runCollectorSilenceAlerts({ ...db, now: clock });
    clock.advance((CONFIRM_HOURS + 1) * HOUR);
    await runCollectorSilenceAlerts({ ...db, now: clock });
    return db;
  }

  /** Carry the state a sweep wrote into a world where the machines are repaired. */
  function repairedWorld(db, beats, clock) {
    const next = makeDb({ beats, clock });
    for (const [k, v] of db.rows) next.rows.set(k, v);
    for (const [id, bc] of db.broadcasts) next.broadcasts.set(id, bc);
    return next;
  }

  it('ends the notice when the machine is beating again', async () => {
    const clock = movableClock();
    const db = await announced(clock);
    const notice = [...db.broadcasts.values()].find((b) => b.target_users[0] === 2);
    assert.equal(notice.ends_at, 'future');

    const fixed = (now) => repairedTools(now, 'LAPTOP-MEMBER1');
    clock.advance(DAY);
    const out = await runCollectorSilenceAlerts({ ...repairedWorld(db, fixed, clock), now: clock });

    assert.equal(out.resolved, 1);
    assert.equal(notice.ends_at, 'ended',
      'they fixed it and are still being told about it in every conversation');
  });

  it('keeps the notice alive while the person\'s other machine is still broken', async () => {
    // One broadcast covers both machines. Ending it when the first is repaired
    // retires the only notice the second will ever get, because its state row
    // stays announced and can no longer be claimed.
    const clock = movableClock();
    const db = await announced(clock, TWO_MACHINES);
    const notice = [...db.broadcasts.values()].find((b) => b.target_users[0] === 2);
    assert.equal(db.rows.size, 2);
    assert.match(notice.body, /BOX-B/);

    // BOX-A repaired, BOX-B still dead.
    const half = (now) => [
      ...repairedTools(now, 'BOX-A', ['claude-code', 'cursor']),
      beat(now, 2, 'member-1', 'BOX-B', 'claude-code', 0.2),
      beat(now, 2, 'member-1', 'BOX-B', 'cursor', 21),
    ];
    clock.advance(DAY);
    const out = await runCollectorSilenceAlerts({ ...repairedWorld(db, half, clock), now: clock });

    assert.equal(out.resolved, 1);
    assert.equal(notice.ends_at, 'future',
      'the notice about the machine that is still broken was retired with the one that was fixed');
  });

  it('ends it once the second machine is repaired too', async () => {
    const clock = movableClock();
    const db = await announced(clock, TWO_MACHINES);
    const notice = [...db.broadcasts.values()].find((b) => b.target_users[0] === 2);

    const bothFixed = (now) => ['BOX-A', 'BOX-B']
      .flatMap((m) => repairedTools(now, m, ['claude-code', 'cursor']));
    clock.advance(DAY);
    const out = await runCollectorSilenceAlerts({ ...repairedWorld(db, bothFixed, clock), now: clock });

    assert.equal(out.resolved, 2);
    assert.equal(notice.ends_at, 'ended');
  });

  it('resolving and ending the notice happen together or not at all', async () => {
    // Marking resolved without ending leaves a repaired machine announced for two
    // more days, and the state row can never be re-evaluated to correct it.
    const src = readFileSync(new URL('../src/jobs/collector-silence-alerts.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('for (const row of resolved)'), src.indexOf('for (const row of cleared)'));
    assert.match(block, /withTransaction\(async \(client\) => \{[\s\S]*END_BROADCAST_SQL[\s\S]*RESOLVE_SQL[\s\S]*\}\)/);
  });

  it('a machine that breaks again waits out the window before being announced', async () => {
    const clock = movableClock();
    const db = await announced(clock);
    const fixed = (now) => repairedTools(now, 'LAPTOP-MEMBER1');
    clock.advance(DAY);
    const recovered = repairedWorld(db, fixed, clock);
    await runCollectorSilenceAlerts({ ...recovered, now: clock });

    clock.advance(30 * DAY);
    const brokenAgain = repairedWorld(recovered, BROKEN, clock);
    assert.equal((await runCollectorSilenceAlerts({ ...brokenAgain, now: clock })).announced, 0,
      're-detection skipped the confirmation window');
    clock.advance((CONFIRM_HOURS + 1) * HOUR);
    const out = await runCollectorSilenceAlerts({ ...brokenAgain, now: clock });
    assert.equal(out.announced, 1);
    // A fresh notice, not the expired one from the first break.
    const notices = [...brokenAgain.broadcasts.values()].filter((b) => b.target_users[0] === 2);
    assert.equal([...brokenAgain.rows.values()][0].broadcast_id, notices.at(-1).id);
  });
});

describe('v1.26.102 — the statements the fake cannot vouch for', () => {
  /**
   * The fake interprets the confirmation window, the claim's WHERE and the
   * shared-broadcast guard itself. That makes both ends of those interfaces
   * ours, so the tests above prove the two agree and say nothing about the SQL
   * that runs in production — deleting the claim's WHERE entirely once left every
   * behavioural test green, which is how this suite was checked.
   *
   * Reading the text is weaker than running it, and that is said here rather
   * than dressed up: this catches a clause being deleted or reworded, not one
   * that is present and wrong. The semantics were exercised against the real
   * database, in a rolled-back transaction, and recorded in the change folder.
   */
  const source = readFileSync(
    new URL('../src/jobs/collector-silence-alerts.js', import.meta.url), 'utf8'
  );
  const statement = (name, next) => source.slice(source.indexOf(`const ${name}`), source.indexOf(`const ${next}`));

  it('the claim will not announce a machine that has not been seen twice', () => {
    const claim = statement('CLAIM_SQL', 'RECORD_BROADCAST_SQL');
    assert.match(claim, /first_seen_at <= NOW\(\) - INTERVAL '\$\{CONFIRM_HOURS\} hours'/);
  });

  it('the claim will not announce a machine that is already announced or resolved', () => {
    const claim = statement('CLAIM_SQL', 'RECORD_BROADCAST_SQL');
    assert.match(claim, /resolved_at IS NULL/);
    assert.match(claim, /announced_at IS NULL\s*\n\s*OR announced_at < NOW\(\) - INTERVAL '\$\{REANNOUNCE_DAYS\} days'/);
    assert.match(claim, /RETURNING user_id, machine/,
      'without RETURNING the job cannot tell a claim it won from one it lost');
  });

  it('re-announcing clears the broadcast it is replacing', () => {
    assert.match(statement('CLAIM_SQL', 'RECORD_BROADCAST_SQL'), /broadcast_id = NULL/);
  });

  it('the sighting resets the clock only for a machine that had recovered', () => {
    // Resetting unconditionally would push first_seen_at forward every sweep and
    // a permanently broken machine would never clear the confirmation window.
    const sighting = statement('SIGHTING_SQL', 'CLAIM_SQL');
    assert.match(sighting, /first_seen_at = CASE WHEN collector_silence_alert_state\.resolved_at IS NOT NULL/);
    assert.match(sighting, /ON CONFLICT \(user_id, machine\) DO UPDATE/);
  });

  it('ending a shared notice excludes only the machine being resolved', () => {
    const ending = statement('END_BROADCAST_SQL', 'CLEAR_SIGHTING_SQL');
    assert.match(ending, /NOT EXISTS/);
    assert.match(ending, /s\.resolved_at IS NULL/);
    assert.match(ending, /NOT \(s\.user_id = \$2 AND s\.machine = \$3\)/);
  });

  it('clearing a sighting cannot delete something already announced', () => {
    assert.match(statement('CLEAR_SIGHTING_SQL', 'SUPER_ADMIN_SQL'), /AND announced_at IS NULL/);
  });
});

describe('v1.26.102 — when a write fails', () => {
  async function seen(db, clock) {
    await runCollectorSilenceAlerts({ ...db, now: clock });
    clock.advance((CONFIRM_HOURS + 1) * HOUR);
  }

  it('a failed broadcast leaves nothing claimed, so the next sweep retries', async () => {
    // The failure that no client-side undo can cover: claim commits, response is
    // lost. Rolling back is decided by the server, the only place that knows.
    const clock = movableClock();
    const db = makeDb({ clock });
    await seen(db, clock);
    db.failBroadcasts(new Error('broadcast insert exploded'));

    await assert.rejects(() => runCollectorSilenceAlerts({ ...db, now: clock }));
    assert.equal([...db.rows.values()][0].announced_at, null,
      'the machine was marked announced with nothing announced');

    const retry = makeDb({ clock });
    for (const [k, v] of db.rows) retry.rows.set(k, v);
    assert.equal((await runCollectorSilenceAlerts({ ...retry, now: clock })).announced, 1);
  });

  it('a member message failing on its own also rolls the claim back', async () => {
    // Separate from the test above, which fails every insert: with both failing,
    // a bug that swallowed the member error would still be caught by the admin
    // insert throwing, and the member half would be untested.
    const clock = movableClock();
    const db = makeDb({ clock });
    await seen(db, clock);
    db.failBroadcastsFor(2);

    await assert.rejects(() => runCollectorSilenceAlerts({ ...db, now: clock }));
    assert.equal([...db.rows.values()][0].announced_at, null);
    assert.equal(db.broadcasts.size, 0);
  });

  it('with no super_admin the person is still told', async () => {
    // Nobody to summarise to is not a reason to leave the person in the dark.
    const clock = movableClock();
    const db = makeDb({ admins: [], clock });
    await seen(db, clock);
    const out = await runCollectorSilenceAlerts({ ...db, now: clock });

    assert.equal(out.announced, 1);
    assert.equal(db.broadcasts.size, 1);
    assert.equal([...db.broadcasts.values()][0].target_users[0], 2);
  });

  it('recoveries are written after the announcing, so they cannot block it', async () => {
    // They used to run first, and one failing UPDATE there aborted the sweep
    // before anything was announced — every day, for as long as the bad row
    // existed. Nothing about a recovery needs writing before a different
    // machine's break is announced.
    const src = readFileSync(new URL('../src/jobs/collector-silence-alerts.js', import.meta.url), 'utf8');
    assert.ok(src.indexOf('INSERT INTO broadcast_messages') < src.indexOf('for (const row of resolved)'),
      'a failing recovery write can stop somebody being told their collector died');
  });
});

describe('v1.26.102 — who is left out', () => {
  it('a member exempted from usage tracking is not queried at all', async () => {
    // Their usage is uncounted by agreement, so a dead collector on their
    // machine is not a fault anyone needs telling about. Asserted on the SQL
    // because the exclusion has to happen in the read, not after it.
    const db = makeDb();
    await runCollectorSilenceAlerts({ ...db, now: () => NOW });
    const read = db.calls.find((c) => c.sql.includes('FROM collector_heartbeat'));
    assert.match(read.sql, /usage_tracking_exemption/);
    assert.match(read.sql, /expires_at IS NULL OR e\.expires_at > NOW\(\)/);
  });
});

describe('v1.26.102 — the two timings, pinned to what they are for', () => {
  /**
   * The fake reads these constants rather than restating them, which is right —
   * but it means no behavioural test can tell a sensible value from a nonsense
   * one, because both move together. These assert the properties the numbers
   * exist to satisfy, which is the only thing that can.
   */

  it('the confirmation window outlasts the slowest scanner schedule', () => {
    // A computer switched on after a long absence has one fresh MCP heartbeat and
    // several stale scanner rows until the scanner next runs. Windows repeats
    // every 120 minutes (scripts/windows/register-scanner-task.ps1), macOS every
    // 1800s and systemd every 30min. Confirming inside that window would announce
    // a fault on a machine that is fine.
    const slowestScheduleHours = 2;
    assert.ok(CONFIRM_HOURS > slowestScheduleHours,
      `confirmation window ${CONFIRM_HOURS}h does not outlast the ${slowestScheduleHours}h Windows interval`);
  });

  it('the confirmation window still lets a real finding surface overnight', () => {
    // Sweeps are daily plus one per deploy. A window longer than a day would mean
    // a machine could be seen and never confirmed.
    assert.ok(CONFIRM_HOURS < 24, 'a window this long can outlast the gap between sweeps');
  });

  it('a machine is never re-announced while its previous notice is still up', () => {
    // The broadcast lives 48 hours. Re-announcing inside that window would put
    // two live notices about one machine in front of the same reader.
    const noticeLifeDays = 2;
    assert.ok(REANNOUNCE_DAYS > noticeLifeDays,
      `re-announce after ${REANNOUNCE_DAYS}d overlaps the ${noticeLifeDays}d notice`);
  });

  it('a machine that nobody fixes is raised again well inside the incident that prompted this', () => {
    // One member's collector was dead for twenty days and nothing said so twice.
    // A re-announce interval at or beyond that reproduces the original failure.
    assert.ok(REANNOUNCE_DAYS < 20,
      'a still-broken machine would stay unmentioned as long as the incident this feature exists for');
  });

  it('the interval the broadcast SQL writes is the one the notice life is judged against', () => {
    // The 48 hours is written into the INSERT, not into a constant, so the
    // assertion above would keep passing if somebody widened it there.
    const src = readFileSync(new URL('../src/jobs/collector-silence-alerts.js', import.meta.url), 'utf8');
    assert.match(src, /NOW\(\) \+ INTERVAL '48 hours'/);
  });
});

describe('v1.32.15 — one failed run, then the machine went quiet', () => {
  /*
   * Measured on production 2026-10-19. A member's Mac ran the scanner at 19:31 on a Friday.
   * The claude-code upload timed out ("This operation was aborted"), so that one tool wrote
   * adapter_error; the other four wrote no_new_activity in the same second. Then the lid
   * closed for the weekend.
   *
   * 04:00 Saturday: first sighting. 04:00 Sunday: the confirmation window had long passed,
   * the row was still adapter_error, and the admin was told the collector "fails every run".
   * Nothing had run in between. The window is there so the scanner gets another run before
   * anybody is told; measuring it in hours since the sighting let a sleeping machine pass
   * it without running once. Monday 12:52 the next run succeeded.
   */
  const TOOLS = ['antigravity', 'claude-code', 'codex', 'cursor', 'opencode'];
  const FAILED_AT = new Date(NOW.getTime() - 8.5 * HOUR);
  /** Every tool written by one run at `at`; claude-code reports `claudeReason`. */
  const oneRun = (at, claudeReason) => TOOLS.map((tool) => ({
    user_id: 2,
    user_name: 'member-1',
    machine: 'MEMBER1-MAC.local',
    tool,
    last_reported_at: at,
    reason: tool === 'claude-code' ? claudeReason : 'no_new_activity',
  }));

  it('is not announced while nothing has run on the machine since the sighting', async () => {
    const clock = movableClock();
    const db = makeDb({ beats: () => oneRun(FAILED_AT, 'adapter_error'), clock });

    const first = await runCollectorSilenceAlerts({ ...db, now: clock });
    assert.equal(first.seen, 1, 'the fixture no longer reads as a failing collector');

    clock.advance(24 * HOUR);
    const second = await runCollectorSilenceAlerts({ ...db, now: clock });
    assert.equal(second.seen, 1, 'a day later the machine should still read as broken');
    assert.equal(second.announced, 0,
      'announced a failure that was seen once, on a machine that has not run since');
    assert.equal(db.broadcasts.size, 0);
  });

  it('is announced once the machine has run again and the tool failed again', async () => {
    // The other half. Without it, a rule that never announces a failing tool at all would
    // pass the test above.
    const clock = movableClock();
    let current = () => oneRun(FAILED_AT, 'adapter_error');
    const db = makeDb({ beats: (now) => current(now), clock });
    await runCollectorSilenceAlerts({ ...db, now: clock });

    clock.advance(24 * HOUR);
    current = (now) => oneRun(new Date(now.getTime() - HOUR), 'adapter_error');
    const out = await runCollectorSilenceAlerts({ ...db, now: clock });
    assert.equal(out.announced, 1, 'a collector that failed on two runs was not announced');
  });

  it('leaves no record behind once the next run succeeds', async () => {
    const clock = movableClock();
    let current = () => oneRun(FAILED_AT, 'adapter_error');
    const db = makeDb({ beats: (now) => current(now), clock });
    await runCollectorSilenceAlerts({ ...db, now: clock });
    clock.advance(24 * HOUR);
    await runCollectorSilenceAlerts({ ...db, now: clock });

    clock.advance(24 * HOUR);
    current = (now) => oneRun(new Date(now.getTime() - HOUR), 'no_new_activity');
    const out = await runCollectorSilenceAlerts({ ...db, now: clock });
    assert.equal(out.announced, 0);
    assert.equal(db.rows.size, 0, 'the sighting outlived the problem');
  });

  it('is not announced when only an MCP start refreshed the failing row', async () => {
    // Claude Code's MCP beats the claude-code row on every start, and a reasonless beat keeps
    // the stored adapter_error. The lid opening at 09:00 and closing before the scanner's next
    // run is not a second run of the scanner.
    const clock = movableClock();
    let current = () => oneRun(FAILED_AT, 'adapter_error');
    const db = makeDb({ beats: (now) => current(now), clock });
    await runCollectorSilenceAlerts({ ...db, now: clock });

    clock.advance(24 * HOUR);
    const mcpStart = new Date(clock().getTime() - 19 * HOUR);
    current = () => oneRun(FAILED_AT, 'adapter_error').map((row) => (
      row.tool === 'claude-code' ? { ...row, last_reported_at: mcpStart } : row
    ));
    const out = await runCollectorSilenceAlerts({ ...db, now: clock });
    assert.equal(out.seen, 1);
    assert.equal(out.announced, 0, 'an MCP start was taken for a second scanner run');
  });

  it('a tool frozen past STALE_DAYS is still confirmed by time alone', async () => {
    // The shape this alert was built for, on a desktop that keeps one IDE open for days: the
    // only fresh row is an MCP beat from before the sighting, and nothing newer arrives.
    const clock = movableClock();
    const mcpBeat = new Date(NOW.getTime() - HOUR);
    const frozen = new Date(NOW.getTime() - 11.2 * DAY);
    const rows = [
      { user_id: 2, user_name: 'member-1', machine: 'DESKTOP-1', tool: 'claude-code', last_reported_at: mcpBeat, reason: 'ok' },
      { user_id: 2, user_name: 'member-1', machine: 'DESKTOP-1', tool: 'cursor', last_reported_at: frozen, reason: 'no_new_activity' },
      { user_id: 2, user_name: 'member-1', machine: 'DESKTOP-1', tool: 'opencode', last_reported_at: frozen, reason: 'no_new_activity' },
    ];
    const db = makeDb({ beats: () => rows, clock });
    await runCollectorSilenceAlerts({ ...db, now: clock });
    clock.advance(24 * HOUR);
    const out = await runCollectorSilenceAlerts({ ...db, now: clock });
    assert.equal(out.announced, 1, 'a scanner dead for eleven days waited for an IDE restart');
  });

  it('the claim requires a run after the sighting only when it is given one to check', () => {
    const source = readFileSync(
      new URL('../src/jobs/collector-silence-alerts.js', import.meta.url), 'utf8'
    );
    const claim = source.slice(source.indexOf('const CLAIM_SQL'), source.indexOf('const RECORD_BROADCAST_SQL'));
    assert.match(claim, /AND \(\$3::timestamptz IS NULL OR \$3::timestamptz > first_seen_at\)/);
  });
});
