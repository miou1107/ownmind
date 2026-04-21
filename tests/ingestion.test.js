import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { createEventsRouter, validateEvent } = await import('../src/routes/usage/events.js');

// ────────────────────────────────────────────────────────────
// test helpers
// ────────────────────────────────────────────────────────────

function buildApp({ queryFn, user, recomputeDaily } = {}) {
  const fakeAuth = (req, _res, next) => { req.user = user; next(); };
  const router = createEventsRouter({
    query: queryFn,
    auth: fakeAuth,
    recomputeDaily: recomputeDaily ?? (async () => ({ skipped: true }))
  });
  const app = express();
  app.use(express.json());
  app.use('/api/usage/events', router);
  return app;
}

async function request(app, { method, path, body }) {
  return await new Promise((resolve, reject) => {
    const req = {
      method, url: path, path,
      headers: { 'content-type': 'application/json' },
      body: body || {}
    };
    const res = {
      statusCode: 200,
      _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
      getHeader(k) { return this._headers[k]; },
      status(c) { this.statusCode = c; return this; },
      json(p) { resolve({ status: this.statusCode, body: p }); },
      send(p) { resolve({ status: this.statusCode, body: p }); },
      end() { resolve({ status: this.statusCode, body: null }); }
    };
    try { app.handle(req, res, (err) => err ? reject(err) : resolve({ status: res.statusCode })); }
    catch (e) { reject(e); }
  });
}

/**
 * Build a mock `query` that dispatches on SQL substrings.
 * `state.events` is mutated to simulate INSERT / SELECT MAX behaviour.
 */
function makeFakeQuery(state = { events: [], audits: [] }) {
  return async (sql, params) => {
    // Model allowlist lookup
    if (/FROM model_pricing/.test(sql) && /SELECT DISTINCT tool, model/.test(sql)) {
      const tools = params[0]; const models = params[1];
      const rows = [];
      for (let i = 0; i < tools.length; i += 1) {
        if (state.knownModels?.has(`${tools[i]}::${models[i]}`)) {
          rows.push({ tool: tools[i], model: models[i] });
        }
      }
      return { rows };
    }
    // session max lookup
    if (/MAX\(cumulative_total_tokens\) AS max_cum/.test(sql)) {
      const userId = params[0];
      const tools = params[1]; const sessions = params[2];
      const rows = [];
      for (let i = 0; i < tools.length; i += 1) {
        const max = state.events
          .filter((e) => e.user_id === userId && e.tool === tools[i] && e.session_id === sessions[i])
          .reduce((m, e) => Math.max(m, e.cumulative_total_tokens), 0);
        if (max > 0) rows.push({ tool: tools[i], session_id: sessions[i], max_cum: max });
      }
      return { rows };
    }
    // INSERT token_events
    if (/INSERT INTO token_events/.test(sql)) {
      const [user_id, tool, session_id, message_id] = params;
      const dup = state.events.find((e) =>
        e.user_id === user_id && e.tool === tool &&
        e.session_id === session_id && e.message_id === message_id);
      if (dup) return { rowCount: 0, rows: [] };
      state.events.push({
        user_id, tool, session_id, message_id,
        model: params[4], ts: params[5],
        input_tokens: params[6], output_tokens: params[7],
        cache_creation_tokens: params[8], cache_read_tokens: params[9], reasoning_tokens: params[10],
        native_cost_usd: params[11], source_file: params[12],
        cumulative_total_tokens: params[13],
        codex_fingerprint_material: params[14]
      });
      return { rowCount: 1, rows: [{ id: state.events.length }] };
    }
    // INSERT audit
    if (/INSERT INTO usage_audit_log/.test(sql)) {
      state.audits.push({
        user_id: params[0], tool: params[1],
        event_type: params[2], details: JSON.parse(params[3])
      });
      return { rowCount: 1, rows: [] };
    }
    throw new Error('unexpected SQL: ' + sql);
  };
}

// ────────────────────────────────────────────────────────────
// validateEvent — pure
// ────────────────────────────────────────────────────────────

describe('validateEvent', () => {
  it('accepts a complete Tier 1 event', () => {
    assert.equal(validateEvent({
      tool: 'claude-code', session_id: 's1', message_id: 'm1',
      ts: '2026-04-21T09:00:00Z', cumulative_total_tokens: 100
    }), null);
  });

  it('rejects missing message_id', () => {
    const err = validateEvent({
      tool: 'claude-code', session_id: 's1', ts: '2026-04-21T09:00:00Z',
      cumulative_total_tokens: 1
    });
    assert.match(err, /message_id/);
  });

  it('rejects missing cumulative_total_tokens for Tier 1', () => {
    const err = validateEvent({
      tool: 'codex', session_id: 's1', message_id: 'm1', ts: '2026-04-21T09:00:00Z'
    });
    assert.match(err, /cumulative_total_tokens/);
  });

  it('rejects invalid ts', () => {
    const err = validateEvent({
      tool: 'claude-code', session_id: 's1', message_id: 'm1',
      ts: 'not-a-date', cumulative_total_tokens: 1
    });
    assert.match(err, /ts/);
  });
});

// ────────────────────────────────────────────────────────────
// POST /api/usage/events
// ────────────────────────────────────────────────────────────

describe('POST /api/usage/events', () => {
  it('rejects empty events array', async () => {
    const app = buildApp({ queryFn: async () => { throw new Error('no-db'); }, user: { id: 1 } });
    const res = await request(app, { method: 'POST', path: '/api/usage/events', body: { events: [] } });
    assert.equal(res.status, 400);
  });

  it('dedupes events on UNIQUE (user, tool, session, message_id)', async () => {
    const state = { events: [], audits: [], knownModels: new Set(['claude-code::opus']) };
    const app = buildApp({ queryFn: makeFakeQuery(state), user: { id: 1 } });
    const evt = {
      tool: 'claude-code', session_id: 's1', message_id: 'msg_1',
      model: 'opus', ts: '2026-04-21T09:00:00Z',
      input_tokens: 10, output_tokens: 5, cumulative_total_tokens: 15
    };

    const r1 = await request(app, { method: 'POST', path: '/api/usage/events', body: { events: [evt] } });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.accepted, 1);
    assert.equal(r1.body.duplicated, 0);

    const r2 = await request(app, { method: 'POST', path: '/api/usage/events', body: { events: [evt] } });
    assert.equal(r2.body.accepted, 0);
    assert.equal(r2.body.duplicated, 1);
    assert.equal(state.events.length, 1, 'DB should still hold 1 row');
  });

  it('writes unknown_model audit log but still accepts the event', async () => {
    const state = { events: [], audits: [], knownModels: new Set() };  // 沒有任何已知 model
    const app = buildApp({ queryFn: makeFakeQuery(state), user: { id: 1 } });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/events',
      body: { events: [{
        tool: 'claude-code', session_id: 's1', message_id: 'm1',
        model: 'fake-model', ts: '2026-04-21T09:00:00Z',
        input_tokens: 0, output_tokens: 0, cumulative_total_tokens: 1
      }] }
    });
    assert.equal(res.body.accepted, 1);
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].event_type, 'unknown_model');
    assert.equal(state.audits[0].details.model, 'fake-model');
  });

  it('writes token_regression audit when new cumulative < previous max', async () => {
    const state = {
      events: [{
        user_id: 1, tool: 'claude-code', session_id: 's1', message_id: 'prev',
        model: 'opus', ts: new Date('2026-04-21T09:00:00Z'),
        cumulative_total_tokens: 1000,
        input_tokens: 0, output_tokens: 0,
        cache_creation_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0
      }],
      audits: [], knownModels: new Set(['claude-code::opus'])
    };
    const app = buildApp({ queryFn: makeFakeQuery(state), user: { id: 1 } });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/events',
      body: { events: [{
        tool: 'claude-code', session_id: 's1', message_id: 'new',
        model: 'opus', ts: '2026-04-21T10:00:00Z',
        cumulative_total_tokens: 500   // 比 1000 小 → regression
      }] }
    });
    assert.equal(res.body.accepted, 1, 'event 仍應接收');
    const reg = state.audits.find((a) => a.event_type === 'token_regression');
    assert.ok(reg, 'token_regression 應該寫入 audit');
    assert.equal(reg.details.expected_min, 1000);
    assert.equal(reg.details.actual, 500);
  });

  it('server-computed aggregation is invoked per touched (tool, session, date)', async () => {
    const state = { events: [], audits: [], knownModels: new Set(['claude-code::opus']) };
    const touched = [];
    const app = buildApp({
      queryFn: makeFakeQuery(state),
      user: { id: 1 },
      recomputeDaily: async (_deps, keys) => { touched.push(keys); return { skipped: false }; }
    });
    await request(app, {
      method: 'POST', path: '/api/usage/events',
      body: { events: [
        { tool: 'claude-code', session_id: 's1', message_id: 'a',
          model: 'opus', ts: '2026-04-21T09:00:00Z', cumulative_total_tokens: 1 },
        { tool: 'claude-code', session_id: 's1', message_id: 'b',
          model: 'opus', ts: '2026-04-21T10:00:00Z', cumulative_total_tokens: 2 },
        { tool: 'claude-code', session_id: 's2', message_id: 'c',
          model: 'opus', ts: '2026-04-21T11:00:00Z', cumulative_total_tokens: 1 }
      ] }
    });
    // session s1 與 s2 各一次（同一 Asia/Taipei date 合併）
    assert.equal(touched.length, 2);
    const keys = touched.map((t) => `${t.tool}/${t.sessionId}/${t.date}`);
    assert.ok(keys.includes('claude-code/s1/2026-04-21'));
    assert.ok(keys.includes('claude-code/s2/2026-04-21'));
  });

  it('rejects batch > 5000 events with 413', async () => {
    const app = buildApp({ queryFn: async () => { throw new Error('no-db'); }, user: { id: 1 } });
    const events = new Array(5001).fill(null).map((_, i) => ({
      tool: 'claude-code', session_id: 's1', message_id: `m${i}`,
      ts: '2026-04-21T09:00:00Z', cumulative_total_tokens: i
    }));
    const res = await request(app, { method: 'POST', path: '/api/usage/events', body: { events } });
    assert.equal(res.status, 413);
  });

  it('returns rejected list for malformed events but accepts valid ones', async () => {
    const state = { events: [], audits: [], knownModels: new Set(['claude-code::opus']) };
    const app = buildApp({ queryFn: makeFakeQuery(state), user: { id: 1 } });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/events',
      body: { events: [
        { tool: 'claude-code', session_id: 's1', message_id: 'good',
          model: 'opus', ts: '2026-04-21T09:00:00Z', cumulative_total_tokens: 1 },
        { tool: 'claude-code', session_id: 's1' }  // 缺 message_id / ts / cumulative
      ] }
    });
    assert.equal(res.body.accepted, 1);
    assert.equal(res.body.rejected.length, 1);
    assert.equal(res.body.rejected[0].index, 1);
  });
});
