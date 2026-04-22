import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { createExemptionsRouter } = await import('../src/routes/usage/exemptions.js');

function buildApp({ queryFn, user }) {
  const fakeSuperAdmin = (req, res, next) => {
    req.user = user;
    if (!user || user.role !== 'super_admin') {
      return res.status(403).json({ error: '需要超級管理員權限' });
    }
    next();
  };
  const router = createExemptionsRouter({ query: queryFn, superAdminAuth: fakeSuperAdmin });
  const app = express();
  app.use(express.json());
  app.use('/api/usage/exemptions', router);
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
      statusCode: 200, _headers: {},
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

describe('GET /api/usage/exemptions', () => {
  it('rejects non super_admin with 403', async () => {
    const app = buildApp({ queryFn: async () => { throw new Error('no-db'); },
      user: { id: 2, role: 'admin' } });
    const res = await request(app, { method: 'GET', path: '/api/usage/exemptions' });
    assert.equal(res.status, 403);
  });

  it('returns list of exemptions for super_admin', async () => {
    const fakeRows = [
      { user_id: 5, name: 'Alice', email: 'a@x.com',
        granted_by: 1, granted_by_name: 'Vin',
        reason: '休假', granted_at: '2026-04-20', expires_at: null }
    ];
    const app = buildApp({
      queryFn: async () => ({ rows: fakeRows }),
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, { method: 'GET', path: '/api/usage/exemptions' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, fakeRows);
  });
});

describe('POST /api/usage/exemptions', () => {
  it('rejects missing user_id with 400', async () => {
    const app = buildApp({
      queryFn: async () => { throw new Error('no-db'); },
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/exemptions',
      body: { reason: '休假' }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /user_id/);
  });

  it('rejects missing reason with 400', async () => {
    const app = buildApp({
      queryFn: async () => { throw new Error('no-db'); },
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/exemptions',
      body: { user_id: 5 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /reason/);
  });

  it('rejects whitespace-only reason', async () => {
    const app = buildApp({
      queryFn: async () => { throw new Error('no-db'); },
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/exemptions',
      body: { user_id: 5, reason: '   ' }
    });
    assert.equal(res.status, 400);
  });

  it('creates new exemption → 201 + exemption_granted audit', async () => {
    const captured = { inserts: [], audits: [] };
    const fakeQuery = async (sql, params) => {
      if (/SELECT reason, expires_at FROM usage_tracking_exemption/.test(sql)) {
        return { rows: [] };  // 無既有 row
      }
      if (/INSERT INTO usage_tracking_exemption/.test(sql)) {
        captured.inserts.push(params);
        return { rows: [{
          user_id: params[0], granted_by: params[1], reason: params[2],
          granted_at: '2026-04-21', expires_at: params[3]
        }] };
      }
      if (/INSERT INTO usage_audit_log/.test(sql)) {
        captured.audits.push({ user_id: params[0], event_type: params[2],
          details: JSON.parse(params[3]) });
        return { rowCount: 1, rows: [] };
      }
      throw new Error('unexpected SQL: ' + sql);
    };
    const app = buildApp({ queryFn: fakeQuery, user: { id: 1, role: 'super_admin' } });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/exemptions',
      body: { user_id: 5, reason: '休假兩週' }
    });
    assert.equal(res.status, 201);
    assert.equal(captured.inserts.length, 1);
    assert.equal(captured.inserts[0][0], 5);
    assert.equal(captured.inserts[0][2], '休假兩週');
    assert.equal(captured.audits.length, 1);
    assert.equal(captured.audits[0].event_type, 'exemption_granted');
    assert.equal(captured.audits[0].details.target_user_id, 5);
  });

  it('updating existing exemption → 200 + exemption_reason_updated audit', async () => {
    const captured = { audits: [] };
    const fakeQuery = async (sql, params) => {
      if (/SELECT reason, expires_at FROM usage_tracking_exemption/.test(sql)) {
        return { rows: [{ reason: '舊原因', expires_at: null }] };
      }
      if (/INSERT INTO usage_tracking_exemption/.test(sql)) {
        return { rows: [{
          user_id: params[0], granted_by: params[1], reason: params[2],
          granted_at: '2026-04-21', expires_at: params[3]
        }] };
      }
      if (/INSERT INTO usage_audit_log/.test(sql)) {
        captured.audits.push({ event_type: params[2], details: JSON.parse(params[3]) });
        return { rowCount: 1, rows: [] };
      }
      throw new Error('unexpected SQL: ' + sql);
    };
    const app = buildApp({ queryFn: fakeQuery, user: { id: 1, role: 'super_admin' } });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/exemptions',
      body: { user_id: 5, reason: '新原因：休假延長' }
    });
    assert.equal(res.status, 200, '覆寫既有應回 200 而非 201');
    assert.equal(captured.audits[0].event_type, 'exemption_reason_updated');
    assert.equal(captured.audits[0].details.prior_reason, '舊原因');
    assert.equal(captured.audits[0].details.new_reason, '新原因：休假延長');
  });
});

describe('DELETE /api/usage/exemptions/:user_id', () => {
  it('rejects non-integer id', async () => {
    const app = buildApp({
      queryFn: async () => { throw new Error('no-db'); },
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'DELETE', path: '/api/usage/exemptions/not-a-number'
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 when no exemption exists', async () => {
    const app = buildApp({
      queryFn: async () => ({ rowCount: 0, rows: [] }),
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'DELETE', path: '/api/usage/exemptions/99'
    });
    assert.equal(res.status, 404);
  });

  it('deletes + writes exemption_revoked audit', async () => {
    const captured = { deletes: [], audits: [] };
    const fakeQuery = async (sql, params) => {
      if (/DELETE FROM usage_tracking_exemption/.test(sql)) {
        captured.deletes.push(params);
        return { rowCount: 1,
          rows: [{ user_id: params[0], reason: '休假', granted_at: '2026-04-20' }] };
      }
      if (/INSERT INTO usage_audit_log/.test(sql)) {
        captured.audits.push({ event_type: params[2], details: JSON.parse(params[3]) });
        return { rowCount: 1, rows: [] };
      }
      throw new Error('unexpected SQL: ' + sql);
    };
    const app = buildApp({ queryFn: fakeQuery, user: { id: 1, role: 'super_admin' } });
    const res = await request(app, { method: 'DELETE', path: '/api/usage/exemptions/5' });
    assert.equal(res.status, 200);
    assert.equal(captured.deletes[0][0], 5);
    assert.equal(captured.audits[0].event_type, 'exemption_revoked');
    assert.equal(captured.audits[0].details.target_user_id, 5);
    assert.equal(captured.audits[0].details.prior_reason, '休假');
  });
});
