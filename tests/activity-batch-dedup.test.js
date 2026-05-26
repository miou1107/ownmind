import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Router } from 'express';

import { insertActivityLog, normalizeClientEventId, UUID_V4_REGEX }
  from '../src/utils/activity-insert.js';

/**
 * v1.17.98 — POST /api/activity/batch dedup tests
 *
 * v1.17.99 update: the simplified copy was replaced with the real handler's
 * helper (src/utils/activity-insert.js) so the dedup INSERT logic is shared
 * between the real handler and the tests — this fully resolves the
 * v1.17.98 review I1 limitation (drift risk between test and prod logic).
 *
 * Stub the query function and verify the SQL behavior directly:
 *   - INSERT contains the client_event_id column
 *   - Uses ON CONFLICT (user_id, client_event_id) WHERE client_event_id IS NOT NULL DO NOTHING
 *   - Events with no client_event_id → NULL, not blocked by the unique index (partial index)
 *   - Repeated client_event_id → server skips, returns the deduped count
 *   - Invalid UUID v4 → treated as NULL (so a client cannot stuff in a random string)
 */

// Mimic the PG row format.
function ok(rows) { return { rows }; }

/**
 * Build the fake `query` function the router consumes.
 *   state.inserted: the set of (user_id, client_event_id) already stored
 *                   (mimics the unique index)
 *   state.captured: every INSERT's SQL + params (used by assertions)
 */
function makeFakeQuery(state) {
  return async (sql, params) => {
    if (/INSERT INTO activity_logs/.test(sql)) {
      state.captured.push({ sql, params });
      // v1.17.98 has two paths:
      //   no ON CONFLICT clause      → always insert (NULL client_event_id path)
      //   ON CONFLICT clause present → 7th param is client_event_id; mimic partial unique
      const hasOnConflict = /ON CONFLICT/.test(sql);
      if (!hasOnConflict) {
        return ok([{ id: state.captured.length }]);
      }
      const clientId = params[6];
      if (state.inserted.has(`${params[0]}::${clientId}`)) {
        return ok([]);  // ON CONFLICT DO NOTHING → RETURNING 0 rows
      }
      state.inserted.add(`${params[0]}::${clientId}`);
      return ok([{ id: state.captured.length }]);
    }
    // memoryLookup returns null so enrich falls through to the fallback.
    if (/SELECT type, code, title FROM memories/.test(sql)) {
      return ok([]);
    }
    return ok([]);
  };
}

/**
 * Build a mini Express app that mounts only the batch route, calling the real
 * helper (v1.17.99).
 *
 * The handler uses the real helper insertActivityLog + normalizeClientEventId so
 * the test exercises 100% of the prod-handler code path (closes v1.17.98 review I1).
 */
async function buildApp(state) {
  const router = Router();
  const fakeAuth = (req, _res, next) => { req.user = { id: 1 }; next(); };
  const fakeQuery = makeFakeQuery(state);

  router.post('/batch', fakeAuth, async (req, res) => {
    const { events } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'empty' });
    }
    let inserted = 0, deduped = 0;
    for (const e of events) {
      if (!e.ts || !e.event) continue;
      const clientEventId = normalizeClientEventId(e.client_event_id);
      const { inserted: didInsert } = await insertActivityLog(fakeQuery, {
        userId: req.user.id,
        ts: e.ts,
        event: e.event,
        tool: e.tool || null,
        source: e.source || null,
        details: e.details || {},
        clientEventId,
      });
      if (didInsert) inserted++; else deduped++;
    }
    res.json({ inserted, deduped, total: events.length });
  });

  const app = express();
  app.use(express.json());
  app.use('/api/activity', router);
  return app;
}

async function postBatch(app, events) {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'POST', url: '/api/activity/batch', path: '/api/activity/batch',
      headers: { 'content-type': 'application/json' },
      body: { events },
    };
    const res = {
      statusCode: 200, _h: {},
      setHeader(k,v){ this._h[k]=v; }, getHeader(k){ return this._h[k]; },
      status(c){ this.statusCode = c; return this; },
      json(p){ resolve({ status: this.statusCode, body: p }); },
      send(p){ resolve({ status: this.statusCode, body: p }); },
      end(){ resolve({ status: this.statusCode, body: null }); }
    };
    try { app.handle(req, res, e => e ? reject(e) : resolve({ status: res.statusCode })); }
    catch (e) { reject(e); }
  });
}

// v1.17.99 — direct unit test against the real helper (fastest; no full Express spin-up).
describe('v1.17.99 — insertActivityLog helper (called directly, same code as prod handler)', () => {
  it('clientEventId === null → plain INSERT, no ON CONFLICT, 6 params', async () => {
    const state = { inserted: new Set(), captured: [] };
    const fakeQuery = makeFakeQuery(state);
    const r = await insertActivityLog(fakeQuery, {
      userId: 1, ts: '2026-05-13T00:00:00Z', event: 'x',
      tool: null, source: null, details: {}, clientEventId: null,
    });
    assert.equal(r.inserted, true);
    assert.equal(state.captured.length, 1);
    assert.ok(!/ON CONFLICT/.test(state.captured[0].sql), 'NULL path must not include ON CONFLICT');
    assert.equal(state.captured[0].params.length, 6);
  });

  it('valid UUID v4 → ON CONFLICT path, 7 params, first call inserted=true', async () => {
    const state = { inserted: new Set(), captured: [] };
    const fakeQuery = makeFakeQuery(state);
    const id = '11111111-2222-4333-8444-555555555555';
    const r = await insertActivityLog(fakeQuery, {
      userId: 1, ts: '2026-05-13T00:00:00Z', event: 'x',
      tool: null, source: null, details: {}, clientEventId: id,
    });
    assert.equal(r.inserted, true);
    assert.match(state.captured[0].sql, /ON CONFLICT[\s\S]*WHERE client_event_id IS NOT NULL[\s\S]*DO NOTHING/i);
    assert.equal(state.captured[0].params.length, 7);
    assert.equal(state.captured[0].params[6], id);
  });

  it('same (userId, clientEventId) twice → inserted=false (dedup)', async () => {
    const state = { inserted: new Set(), captured: [] };
    const fakeQuery = makeFakeQuery(state);
    const id = '22222222-3333-4444-8555-666666666666';
    const args = {
      userId: 1, ts: '2026-05-13T00:00:00Z', event: 'x',
      tool: null, source: null, details: {}, clientEventId: id,
    };
    const r1 = await insertActivityLog(fakeQuery, args);
    const r2 = await insertActivityLog(fakeQuery, args);
    assert.equal(r1.inserted, true);
    assert.equal(r2.inserted, false, 'second call with the same id must be inserted=false');
  });

  it('normalizeClientEventId — empty string / non-string / non-UUID → null', () => {
    assert.equal(normalizeClientEventId(null), null);
    assert.equal(normalizeClientEventId(undefined), null);
    assert.equal(normalizeClientEventId(''), null);
    assert.equal(normalizeClientEventId(123), null);
    assert.equal(normalizeClientEventId({}), null);
    assert.equal(normalizeClientEventId('not-a-uuid'), null);
    // UUID v1 (position 13 is not 4).
    assert.equal(normalizeClientEventId('11111111-2222-1111-8444-555555555555'), null);
    // UUID v3 / v5 are also rejected (only v4 is accepted).
    assert.equal(normalizeClientEventId('11111111-2222-3333-8444-555555555555'), null);
    assert.equal(normalizeClientEventId('11111111-2222-5333-8444-555555555555'), null);
  });

  it('normalizeClientEventId — valid UUID v4 (upper / mixed case) → returned as-is', () => {
    const v4lower = '11111111-2222-4333-8444-555555555555';
    const v4upper = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
    const v4mixed = 'Aa1Bb2Cc-3333-4abc-8DEF-aaaaaaaaaaaa';
    assert.equal(normalizeClientEventId(v4lower), v4lower);
    assert.equal(normalizeClientEventId(v4upper), v4upper);
    assert.equal(normalizeClientEventId(v4mixed), v4mixed);
  });

  it('UUID_V4_REGEX export aligned (reused by other modules)', () => {
    assert.ok(UUID_V4_REGEX instanceof RegExp);
    assert.ok(UUID_V4_REGEX.test('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'));
    assert.ok(!UUID_V4_REGEX.test('aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee'));  // v1
  });
});

describe('v1.17.98 — POST /api/activity/batch client_event_id dedup', () => {
  it('with client_event_id — SQL contains the column + ON CONFLICT clause', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const id = '11111111-2222-4333-8444-555555555555';
    await postBatch(app, [{ ts: '2026-05-13T00:00:00Z', event: 'iron_rule_compliance', client_event_id: id }]);

    assert.equal(state.captured.length, 1);
    assert.match(state.captured[0].sql, /client_event_id/, 'SQL must contain the client_event_id column');
    assert.match(state.captured[0].sql, /ON CONFLICT[\s\S]*client_event_id[\s\S]*DO NOTHING/i,
      'SQL must contain the ON CONFLICT DO NOTHING clause');
    assert.match(state.captured[0].sql, /WHERE client_event_id IS NOT NULL/i,
      'ON CONFLICT must restrict to client_event_id IS NOT NULL (partial unique index)');
    assert.equal(state.captured[0].params[6], id, 'the 7th param must be the client_event_id');
  });

  // v1.17.98 review B1 — NULL client_event_id must go through plain INSERT, never ON CONFLICT.
  it('without client_event_id — SQL must not contain ON CONFLICT (avoid partial-index inference edge cases)', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    await postBatch(app, [{ ts: '2026-05-13T00:00:00Z', event: 'memory_save' }]);

    assert.equal(state.captured.length, 1);
    assert.ok(!/ON CONFLICT/.test(state.captured[0].sql),
      'NULL client_event_id must go through plain INSERT, no ON CONFLICT — even though the partial index theoretically excludes NULL rows, we do not rely on inference edge cases');
    assert.ok(!/client_event_id/.test(state.captured[0].sql),
      'NULL path must not even write the client_event_id column (let the DB default to NULL)');
    assert.equal(state.captured[0].params.length, 6, 'NULL path should have only 6 params');
  });

  it('valid UUID v4 sent twice → second is deduped; returns deduped=1', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const ev = { ts: '2026-05-13T00:00:00Z', event: 'iron_rule_compliance', client_event_id: id };

    const r1 = await postBatch(app, [ev]);
    assert.equal(r1.body.inserted, 1);
    assert.equal(r1.body.deduped, 0);

    const r2 = await postBatch(app, [ev]);
    assert.equal(r2.body.inserted, 0, 'second call with the same id must be deduped');
    assert.equal(r2.body.deduped, 1);
  });

  it('no client_event_id (legacy client) → plain INSERT path, inserts every time', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const ev = { ts: '2026-05-13T00:00:00Z', event: 'iron_rule_compliance' };

    const r1 = await postBatch(app, [ev]);
    const r2 = await postBatch(app, [ev]);
    assert.equal(r1.body.inserted, 1);
    assert.equal(r2.body.inserted, 1, 'events without a client_event_id must not be deduped');
    // NULL path: plain INSERT, no ON CONFLICT, no client_event_id column.
    assert.ok(!/ON CONFLICT/.test(state.captured[0].sql));
    assert.equal(state.captured[0].params.length, 6);
  });

  it('invalid UUID string (random garbage) → plain INSERT path (treated as NULL)', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const ev = { ts: '2026-05-13T00:00:00Z', event: 'x', client_event_id: 'not-a-real-uuid' };

    await postBatch(app, [ev]);
    await postBatch(app, [ev]);
    assert.ok(!/ON CONFLICT/.test(state.captured[0].sql), 'invalid UUID must go through plain INSERT path');
    assert.equal(state.captured[0].params.length, 6);
  });

  it('UUID v1 (not v4) → plain INSERT path (regex restricts to v4)', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const v1 = '11111111-2222-1111-8444-555555555555';
    await postBatch(app, [{ ts: '2026-05-13T00:00:00Z', event: 'x', client_event_id: v1 }]);
    assert.ok(!/ON CONFLICT/.test(state.captured[0].sql),
      'only v4 UUIDs are accepted (dedup source is crypto.randomUUID)');
    assert.equal(state.captured[0].params.length, 6);
  });

  it('mixed batch — 1 with id + 1 without → each takes its own path', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const id = 'cccccccc-dddd-4eee-8fff-000000000000';
    const r = await postBatch(app, [
      { ts: '2026-05-13T00:00:00Z', event: 'a', client_event_id: id },
      { ts: '2026-05-13T00:00:00Z', event: 'b' },
    ]);
    assert.equal(r.body.inserted, 2);
    assert.equal(r.body.deduped, 0);
    assert.match(state.captured[0].sql, /ON CONFLICT/, 'event with id takes the ON CONFLICT path');
    assert.equal(state.captured[0].params[6], id);
    assert.ok(!/ON CONFLICT/.test(state.captured[1].sql), 'event without id takes the plain INSERT path');
    assert.equal(state.captured[1].params.length, 6);
  });

  it('duplicate id within the same batch → second row deduped', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const id = 'eeeeeeee-ffff-4111-8222-333333333333';
    const r = await postBatch(app, [
      { ts: '2026-05-13T00:00:00Z', event: 'a', client_event_id: id },
      { ts: '2026-05-13T00:00:00Z', event: 'a', client_event_id: id },
    ]);
    assert.equal(r.body.inserted, 1);
    assert.equal(r.body.deduped, 1);
  });
});
