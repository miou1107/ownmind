import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { createAdminWorkLogRouter } = await import('../src/routes/admin-work-log.js');

function buildApp({ queryFn, user }) {
  const fakeSuperAdmin = (req, res, next) => {
    req.user = user;
    if (!user || user.role !== 'super_admin') {
      return res.status(403).json({ error: '需要超級管理員權限' });
    }
    next();
  };
  const router = createAdminWorkLogRouter({ query: queryFn, superAdminAuth: fakeSuperAdmin });
  const app = express();
  app.use(express.json());
  app.use('/api/admin/work-log', router);
  return app;
}

async function request(app, { method, path }) {
  return await new Promise((resolve) => {
    const req = { method, url: path, path, headers: {} };
    const res = {
      statusCode: 200,
      _body: null,
      setHeader() {},
      getHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(body) { this._body = body; resolve({ status: this.statusCode, body }); return this; },
      send(body) { this._body = body; resolve({ status: this.statusCode, body }); return this; },
      end(body) { this._body = body; resolve({ status: this.statusCode, body }); return this; },
    };
    app(req, res, (err) => err && resolve({ status: 500, body: { error: err.message } }));
  });
}

describe('admin-work-log route', () => {
  it('GET / 拒絕非 super_admin（admin 也不行）', async () => {
    const app = buildApp({
      queryFn: async () => ({ rows: [] }),
      user: { id: 1, role: 'admin' },
    });
    const r = await request(app, { method: 'GET', path: '/api/admin/work-log/' });
    assert.equal(r.status, 403);
  });

  it('GET / 拒絕未登入', async () => {
    const app = buildApp({
      queryFn: async () => ({ rows: [] }),
      user: null,
    });
    const r = await request(app, { method: 'GET', path: '/api/admin/work-log/' });
    assert.equal(r.status, 403);
  });

  it('GET / 預設拉 30 天 100 筆，三來源 union', async () => {
    const captured = [];
    const app = buildApp({
      queryFn: async (sql, params) => {
        captured.push({ sql, params });
        return { rows: [] };
      },
      user: { id: 1, role: 'super_admin' },
    });
    const r = await request(app, { method: 'GET', path: '/api/admin/work-log/' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.rows, []);
    assert.equal(r.body.limit, 100);
    assert.equal(r.body.offset, 0);

    const sql = captured[0].sql;
    assert.match(sql, /UNION ALL/, 'SQL 必須 UNION ALL 三個來源');
    assert.match(sql, /'activity'/, '需有 activity source 標籤');
    assert.match(sql, /'compliance'/, '需有 compliance source 標籤');
    assert.match(sql, /'session'/, '需有 session source 標籤');
    assert.match(sql, /ORDER BY ts DESC/, '依 ts DESC 排序');
    assert.match(sql, /LIMIT \$\d+ OFFSET \$\d+/, 'limit/offset 走 placeholder');
  });

  it('GET / source=activity 只 query activity_logs（不含 compliance / session）', async () => {
    let captured = null;
    const app = buildApp({
      queryFn: async (sql, params) => {
        captured = { sql, params };
        return { rows: [] };
      },
      user: { id: 1, role: 'super_admin' },
    });
    await request(app, { method: 'GET', path: '/api/admin/work-log/?source=activity' });
    const sql = captured.sql;
    assert.match(sql, /'activity'/);
    assert.doesNotMatch(sql, /UNION ALL/, 'source 過濾後不該 UNION 多源');
    assert.doesNotMatch(sql, /session_logs/);
  });

  it('GET / user_id 過濾會帶入 SQL 參數', async () => {
    let captured = null;
    const app = buildApp({
      queryFn: async (sql, params) => {
        captured = { sql, params };
        return { rows: [] };
      },
      user: { id: 1, role: 'super_admin' },
    });
    await request(app, { method: 'GET', path: '/api/admin/work-log/?user_id=42' });
    assert.ok(captured.params.includes(42), 'params 必須含 user_id=42');
  });

  it('GET / q 搜尋會 ILIKE 包成 %q%', async () => {
    let captured = null;
    const app = buildApp({
      queryFn: async (sql, params) => {
        captured = { sql, params };
        return { rows: [] };
      },
      user: { id: 1, role: 'super_admin' },
    });
    await request(app, { method: 'GET', path: '/api/admin/work-log/?q=upgrade' });
    assert.ok(captured.params.some((p) => p === '%upgrade%'), 'q 必須被包成 %upgrade%');
    assert.match(captured.sql, /ILIKE/);
  });

  it('GET / limit > 500 自動 cap 到 500', async () => {
    let captured = null;
    const app = buildApp({
      queryFn: async (sql, params) => {
        captured = { sql, params };
        return { rows: [] };
      },
      user: { id: 1, role: 'super_admin' },
    });
    const r = await request(app, { method: 'GET', path: '/api/admin/work-log/?limit=9999' });
    assert.equal(r.body.limit, 500);
  });

  it('GET / 回傳 rows 帶 total（用 COUNT() OVER）', async () => {
    const app = buildApp({
      queryFn: async () => ({
        rows: [
          { source: 'activity', row_id: 1, ts: '2026-05-07T00:00:00Z', total_count: '3' },
          { source: 'session', row_id: 2, ts: '2026-05-06T00:00:00Z', total_count: '3' },
        ],
      }),
      user: { id: 1, role: 'super_admin' },
    });
    const r = await request(app, { method: 'GET', path: '/api/admin/work-log/' });
    assert.equal(r.body.total, 3);
    assert.equal(r.body.rows.length, 2);
    assert.equal(r.body.rows[0].total_count, undefined, 'total_count 不該洩漏到 rows');
  });

  it('GET /filters 回傳 users / tools / event_types', async () => {
    const app = buildApp({
      queryFn: async (sql) => {
        if (sql.includes('FROM users')) return { rows: [{ id: 1, name: 'Vin', email: 'v@v' }] };
        if (sql.includes('SELECT DISTINCT tool')) return { rows: [{ tool: 'claude-code' }, { tool: 'codex' }] };
        if (sql.includes('SELECT DISTINCT event')) return { rows: [{ event: 'init' }, { event: 'update_check' }] };
        return { rows: [] };
      },
      user: { id: 1, role: 'super_admin' },
    });
    const r = await request(app, { method: 'GET', path: '/api/admin/work-log/filters' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.users, [{ id: 1, name: 'Vin', email: 'v@v' }]);
    assert.deepEqual(r.body.tools, ['claude-code', 'codex']);
    assert.deepEqual(r.body.event_types, ['init', 'update_check']);
  });
});
