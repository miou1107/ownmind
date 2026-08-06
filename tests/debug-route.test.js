import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDebugRouter } from '../src/routes/debug.js';

// Call the router's handler directly, bypassing express's body-parser.
// Same pattern as tests/admin-work-log.test.js.
function buildHandler({ queryFn, user }) {
  const fakeAuth = (req, res, next) => {
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    req.user = user;
    next();
  };
  const router = createDebugRouter({ query: queryFn, auth: fakeAuth });
  return router;
}

async function callRoute(router, body, user) {
  return await new Promise((resolve) => {
    const req = {
      method: 'POST',
      url: '/install-check',
      path: '/install-check',
      originalUrl: '/api/debug/install-check',
      baseUrl: '/api/debug',
      headers: {},
      body,
    };
    const res = {
      statusCode: 200,
      _body: null,
      setHeader() {},
      getHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { this._body = b; resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { this._body = b; resolve({ status: this.statusCode, body: b }); return this; },
      end(b) { this._body = b; resolve({ status: this.statusCode, body: b }); return this; },
    };
    router(req, res, (err) => {
      if (err) resolve({ status: 500, body: { error: err.message } });
    });
  });
}

const validBody = {
  ts: '2026-05-08T01:23:45+08:00',
  trigger: 'post_upgrade',
  client_version: '1.17.63',
  platform: 'darwin',
  node_version: 'v22.0.0',
  machine: 'test-host',
  checks: [
    { name: 'mcp_files', status: 'pass', detail: 'ok' },
    { name: 'scheduler', status: 'fail', detail: 'not registered', fix: 'reinstall' },
  ],
  summary: { pass: 1, warn: 0, fail: 1 },
};

describe('POST /api/debug/install-check', () => {
  it('returns 401 when unauthenticated', async () => {
    const router = buildHandler({ queryFn: async () => ({ rows: [] }), user: null });
    const r = await callRoute(router, validBody, null);
    assert.equal(r.status, 401);
  });

  it('returns ok=true on successful write', async () => {
    let captured = null;
    const queryFn = async (sql, args) => {
      // v1.26.87: the route now also runs the alert evaluator after the insert
      // (against the same query fn), so only capture the write we're asserting on.
      if (sql.includes('INSERT INTO install_check_logs')) captured = { sql, args };
      return { rows: [] };
    };
    const router = buildHandler({ queryFn, user: { id: 99 } });
    const r = await callRoute(router, validBody);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.match(captured.sql, /INSERT INTO install_check_logs/);
    assert.equal(captured.args[0], 99);
    assert.equal(captured.args[2], '1.17.63');
    assert.equal(captured.args[3], 'darwin');
    assert.equal(captured.args[4], 'post_upgrade');
    assert.equal(captured.args[5], 'test-host');
  });

  it('returns 400 when fields are missing', async () => {
    const router = buildHandler({ queryFn: async () => ({ rows: [] }), user: { id: 1 } });
    const r = await callRoute(router, { ts: 'x' });
    assert.equal(r.status, 400);
  });

  it('returns 400 when ts is not a valid date', async () => {
    const router = buildHandler({ queryFn: async () => ({ rows: [] }), user: { id: 1 } });
    const r = await callRoute(router, { ...validBody, ts: 'not-a-date' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /ts/);
  });

  it('returns 400 when checks contain an unknown status', async () => {
    const bad = { ...validBody, checks: [{ name: 'x', status: 'weird', detail: 'd' }] };
    const router = buildHandler({ queryFn: async () => ({ rows: [] }), user: { id: 1 } });
    const r = await callRoute(router, bad);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /status/);
  });

  it('returns 413 when payload exceeds 64KB', async () => {
    const huge = { ...validBody, padding: 'x'.repeat(70 * 1024) };
    const router = buildHandler({ queryFn: async () => ({ rows: [] }), user: { id: 1 } });
    const r = await callRoute(router, huge);
    assert.equal(r.status, 413);
  });

  it('returns 500 on DB failure', async () => {
    const queryFn = async () => { throw new Error('connection refused'); };
    const router = buildHandler({ queryFn, user: { id: 1 } });
    const r = await callRoute(router, validBody);
    assert.equal(r.status, 500);
  });
});
