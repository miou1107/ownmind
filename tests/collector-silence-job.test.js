// tests/collector-silence-job.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runCollectorSilenceAlerts } from '../src/jobs/collector-silence-alerts.js';

const NOW = new Date('2026-08-07T07:10:00Z');
const DAY = 24 * 60 * 60 * 1000;

function beat(user_id, user_name, machine, tool, days) {
  return { user_id, user_name, machine, tool, last_reported_at: new Date(NOW.getTime() - days * DAY) };
}

/** One broken machine: the MCP's tool beating, the scanner's tools frozen. */
const BROKEN = [
  beat(2, 'Amiee Kuo', 'LAPTOP-RGE2HCSQ', 'claude-code', 0.2),
  beat(2, 'Amiee Kuo', 'LAPTOP-RGE2HCSQ', 'cursor', 11.2),
  beat(2, 'Amiee Kuo', 'LAPTOP-RGE2HCSQ', 'opencode', 11.2),
];

const HEALTHY = ['claude-code', 'cursor', 'opencode']
  .map((tool) => beat(7, 'Vincent Kao', 'Vincent.local', tool, 0.1));

/**
 * A fake database that actually keeps the state table, so the claim upsert's
 * conflict clause can be exercised across more than one sweep. Two runs sharing
 * one of these read and write the same rows, which is the only way to tell
 * "claimed it" from "somebody else did".
 *
 * `withTransaction` snapshots the table on entry and restores it if the body
 * throws, which is what a real ROLLBACK does to the same rows.
 *
 * Caveat for whoever writes the next test: the restore puts back the whole
 * table, not only the rows this body wrote.
 */
function makeDb({ beats = BROKEN, admins = [{ id: 1 }] } = {}) {
  const rows = new Map();
  const broadcasts = new Map();
  const calls = [];
  const key = (userId, machine) => JSON.stringify([userId, machine]);
  let nextBroadcastId = 500;
  let txDepth = 0;
  let broadcastError = null;
  let failForUser = null;

  const query = async (sql, params = []) => {
    calls.push({ sql, params, tx: txDepth > 0 });

    if (sql.includes('FROM collector_heartbeat')) return { rows: beats, rowCount: beats.length };

    if (sql.includes('FROM collector_silence_alert_state')) {
      const all = [...rows.values()].map((r) => ({ ...r }));
      return { rows: all, rowCount: all.length };
    }

    if (sql.includes("role = 'super_admin'")) return { rows: admins, rowCount: admins.length };

    if (sql.includes('INSERT INTO collector_silence_alert_state')) {
      const [user_id, machine, stale_tools, last_beat_at] = params;
      const k = key(user_id, machine);
      const prev = rows.get(k);
      // The conditional upsert: an announced-and-still-open row matches nothing.
      if (prev && prev.announced_at && !prev.resolved_at) return { rows: [], rowCount: 0 };
      rows.set(k, {
        user_id, machine, stale_tools, last_beat_at,
        announced_at: NOW, resolved_at: null, broadcast_id: null,
      });
      return { rows: [{ user_id, machine }], rowCount: 1 };
    }

    if (sql.includes('UPDATE collector_silence_alert_state')) {
      const [user_id, machine] = params;
      const row = rows.get(key(user_id, machine));
      if (!row) return { rows: [], rowCount: 0 };
      if (sql.includes('resolved_at = NOW()')) {
        const was = row.broadcast_id;
        row.resolved_at = NOW;
        return { rows: [{ broadcast_id: was }], rowCount: 1 };
      }
      if (sql.includes('broadcast_id = $3')) {
        row.broadcast_id = params[2];
        return { rows: [], rowCount: 1 };
      }
      row.stale_tools = params[2];
      row.last_beat_at = params[3];
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('INSERT INTO broadcast_messages')) {
      if (broadcastError) throw broadcastError;
      if (failForUser !== null && params[2]?.[0] === failForUser) {
        throw new Error(`broadcast insert exploded for user ${failForUser}`);
      }
      const id = nextBroadcastId++;
      broadcasts.set(id, { id, title: params[0], body: params[1], target_users: params[2], ends_at: 'future' });
      return { rows: [{ id }], rowCount: 1 };
    }

    if (sql.includes('UPDATE broadcast_messages')) {
      const bc = broadcasts.get(params[0]);
      if (bc) bc.ends_at = 'ended';
      return { rows: [], rowCount: bc ? 1 : 0 };
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
    failBroadcasts: (err) => { broadcastError = err; },
    failBroadcastsFor: (userId) => { failForUser = userId; },
  };
}

const now = () => NOW;

describe('v1.26.99 — the job announces a dead collector', () => {
  it('writes one message to the person and one to the admin', async () => {
    const db = makeDb();
    const out = await runCollectorSilenceAlerts({ ...db, now });

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

  it('says nothing at all when every machine is healthy', async () => {
    const db = makeDb({ beats: HEALTHY });
    const out = await runCollectorSilenceAlerts({ ...db, now });
    assert.equal(out.announced, 0);
    assert.equal(db.broadcasts.size, 0);
    // Not merely "no broadcast": no transaction should have been opened either.
    assert.equal(db.calls.some((c) => c.tx), false);
  });
});

describe('v1.26.99 — running it twice in a row', () => {
  it('the second sweep announces nothing', async () => {
    // The behaviour the state table exists for. A daily job that re-announces is
    // worse than no job: the reader learns to scroll past the first sentence.
    const db = makeDb();
    const first = await runCollectorSilenceAlerts({ ...db, now });
    const second = await runCollectorSilenceAlerts({ ...db, now });

    assert.equal(first.announced, 1);
    assert.equal(second.announced, 0);
    assert.equal(db.broadcasts.size, 2, 'a second sweep wrote more broadcasts');
  });

  it('a third sweep after the machine recovers ends the notice', async () => {
    const db = makeDb();
    await runCollectorSilenceAlerts({ ...db, now });
    const memberBroadcast = [...db.broadcasts.values()].find((b) => b.target_users[0] === 2);
    assert.equal(memberBroadcast.ends_at, 'future');

    // The scanner is running again: every tool beats.
    const repaired = ['claude-code', 'cursor', 'opencode']
      .map((tool) => beat(2, 'Amiee Kuo', 'LAPTOP-RGE2HCSQ', tool, 0.1));
    const back = makeDb({ beats: repaired });
    // Carry the state the first sweep wrote into the recovered world.
    for (const [k, v] of db.rows) back.rows.set(k, v);
    back.broadcasts.set(memberBroadcast.id, memberBroadcast);

    const out = await runCollectorSilenceAlerts({ ...back, now });
    assert.equal(out.resolved, 1);
    assert.equal(memberBroadcast.ends_at, 'ended',
      'they fixed it and are still being told about it in every conversation');
  });
});

describe('v1.26.99 — the statement the fake cannot vouch for', () => {
  /**
   * The fake above decides for itself that an announced-and-open row claims
   * nothing. That makes both ends of this interface mine, so "the second sweep
   * stays quiet" proves my two fakes agree and says nothing about the SQL that
   * runs in production — deleting the WHERE clause entirely leaves every test
   * above green, which is how this suite was checked.
   *
   * Reading the text is weaker than running it, and it is said out loud here
   * rather than dressed up: this catches the clause being deleted or reworded,
   * not a clause that is present and wrong. The semantics were exercised once
   * against the real database, in a rolled-back transaction, and that run is
   * recorded in the change folder.
   */
  const source = readFileSync(
    new URL('../src/jobs/collector-silence-alerts.js', import.meta.url), 'utf8'
  );

  it('the claim is conditional, so an open finding cannot be re-announced', () => {
    const claim = source.slice(
      source.indexOf('const CLAIM_SQL'),
      source.indexOf('const RECORD_BROADCAST_SQL')
    );
    assert.match(claim, /ON CONFLICT \(user_id, machine\)/);
    assert.match(claim, /WHERE collector_silence_alert_state\.announced_at IS NULL/);
    assert.match(claim, /OR collector_silence_alert_state\.resolved_at IS NOT NULL/);
    assert.match(claim, /RETURNING user_id, machine/,
      'without RETURNING the job cannot tell a claim it won from one it lost');
  });

  it('re-announcing clears the broadcast it is replacing', () => {
    // A machine that broke, recovered, and broke again gets a new notice. Left
    // pointing at the old broadcast, the next recovery would end a message that
    // has already expired and leave the current one running.
    const claim = source.slice(
      source.indexOf('const CLAIM_SQL'), source.indexOf('const RECORD_BROADCAST_SQL')
    );
    assert.match(claim, /broadcast_id = NULL/);
  });
});

describe('v1.26.99 — when a write fails', () => {
  it('a failed broadcast leaves nothing claimed, so the next sweep retries', async () => {
    // The failure that no client-side undo can cover: claim commits, response is
    // lost. Rolling back is decided by the server, which is the only place that
    // knows both halves.
    const db = makeDb();
    db.failBroadcasts(new Error('broadcast insert exploded'));

    await assert.rejects(() => runCollectorSilenceAlerts({ ...db, now }));
    assert.equal(db.rows.size, 0, 'a machine was marked announced with nothing announced');

    // A later sweep, with the fault cleared, must still find it.
    const retry = makeDb();
    assert.equal((await runCollectorSilenceAlerts({ ...retry, now })).announced, 1);
  });

  it('a member message failing on its own also rolls the claim back', async () => {
    // Separate from the test above, which fails every insert: with both failing,
    // a bug that swallowed the member error would still be caught by the admin
    // insert throwing, and the member half would be untested. Verified by
    // wrapping only the member insert in a catch — with that mutation this test
    // fails and the one above does not.
    const db = makeDb();
    db.failBroadcastsFor(2);

    await assert.rejects(() => runCollectorSilenceAlerts({ ...db, now }));
    assert.equal(db.rows.size, 0, 'the machine was marked announced but its owner was never told');
    assert.equal(db.broadcasts.size, 0);
  });

  it('with no super_admin the person is still told', async () => {
    // Nobody to summarise to is not a reason to leave the person in the dark.
    const db = makeDb({ admins: [] });
    const out = await runCollectorSilenceAlerts({ ...db, now });
    assert.equal(out.announced, 1);
    assert.equal(db.broadcasts.size, 1);
    assert.equal([...db.broadcasts.values()][0].target_users[0], 2);
  });
});

describe('v1.26.99 — who is left out', () => {
  it('a member exempted from usage tracking is not queried at all', async () => {
    // Their usage is uncounted by agreement, so a dead collector on their
    // machine is not a fault anyone needs telling about. Asserted on the SQL
    // because the exclusion has to happen in the read, not after it.
    const db = makeDb();
    await runCollectorSilenceAlerts({ ...db, now });
    const read = db.calls.find((c) => c.sql.includes('FROM collector_heartbeat'));
    assert.match(read.sql, /usage_tracking_exemption/);
    assert.match(read.sql, /expires_at IS NULL OR e\.expires_at > NOW\(\)/);
  });
});
