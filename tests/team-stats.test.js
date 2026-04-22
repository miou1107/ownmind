import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { createTeamStatsRouter, parseParams } =
  await import('../src/routes/usage/team-stats.js');

function buildApp({ queryFn, user }) {
  const fakeAdminAuth = (req, res, next) => {
    req.user = user;
    if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    next();
  };
  const router = createTeamStatsRouter({ query: queryFn, adminAuth: fakeAdminAuth });
  const app = express();
  app.use(express.json());
  app.use('/api/usage/team-stats', router);
  return app;
}

async function request(app, { method = 'GET', path }) {
  return await new Promise((resolve, reject) => {
    const req = { method, url: path, path, headers: {}, body: {} };
    const res = {
      statusCode: 200, _headers: {},
      setHeader(k, v) { this._headers[k] = v; }, getHeader(k) { return this._headers[k]; },
      status(c) { this.statusCode = c; return this; },
      json(p) { resolve({ status: this.statusCode, body: p }); },
      send(p) { resolve({ status: this.statusCode, body: p }); },
      end() { resolve({ status: this.statusCode, body: null }); }
    };
    try { app.handle(req, res, (err) => err ? reject(err) : resolve({ status: res.statusCode })); }
    catch (e) { reject(e); }
  });
}

describe('parseParams', () => {
  it('falls back to last 30 days when missing', () => {
    const p = parseParams({});
    assert.match(p.from, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(p.to, /^\d{4}-\d{2}-\d{2}$/);
  });
  it('accepts valid YYYY-MM-DD and rejects junk', () => {
    const p = parseParams({ from: '2026-01-01', to: 'bogus' });
    assert.equal(p.from, '2026-01-01');
    assert.match(p.to, /^\d{4}-\d{2}-\d{2}$/, 'bogus to → fallback');
  });
});

describe('GET /api/usage/team-stats (admin+)', () => {
  it('rejects non-admin with 403', async () => {
    const app = buildApp({ queryFn: async () => { throw new Error('no-db'); }, user: { id: 2, role: 'user' } });
    const res = await request(app, { path: '/api/usage/team-stats' });
    assert.equal(res.status, 403);
  });

  it('returns coverage + users for admin', async () => {
    // mock returns for the three queries: coverage CTE, per_tool, users aggregate
    const fakeQuery = async (sql) => {
      if (/user_status AS/.test(sql)) {
        // Coverage: 1 active, 1 stale (48h+), 1 exempt
        const now = new Date();
        const recent = new Date(now.getTime() - 60_000);
        const old = new Date(now.getTime() - 72 * 60 * 60 * 1000);
        return {
          rows: [
            { id: 1, name: 'Active User', email: 'a@x.com',
              latest_any_hb: recent, exempt_flag: null },
            { id: 2, name: 'Stale User', email: 'b@x.com',
              latest_any_hb: old, exempt_flag: null },
            { id: 3, name: 'Exempt User', email: 'c@x.com',
              latest_any_hb: null, exempt_flag: 1 }
          ]
        };
      }
      if (/FROM collector_heartbeat\s+GROUP BY tool/.test(sql)) {
        return { rows: [
          { tool: 'claude-code', reporting: '1', stale: '0' },
          { tool: 'codex', reporting: '0', stale: '1' }
        ] };
      }
      if (/FROM users u\s+LEFT JOIN token_usage_daily/.test(sql)) {
        return { rows: [
          { id: 1, name: 'Active User', email: 'a@x.com',
            cost_usd: 1.5, input_tokens: '100', output_tokens: '50',
            cache_creation_tokens: '0', cache_read_tokens: '10', reasoning_tokens: '5',
            message_count: 10, wall_seconds: 3600, active_seconds: 1800, session_count: 3 }
        ] };
      }
      if (/FROM session_count\s+WHERE date/.test(sql)) {
        // Tier-2 aggregate per user（此測試沒 Cursor/Antigravity 資料）
        return { rows: [] };
      }
      throw new Error('unexpected SQL: ' + sql);
    };
    const app = buildApp({ queryFn: fakeQuery, user: { id: 9, role: 'admin' } });
    const res = await request(app, { path: '/api/usage/team-stats?from=2026-04-01&to=2026-04-30' });
    assert.equal(res.status, 200);
    assert.equal(res.body.coverage.total_users, 3);
    assert.equal(res.body.coverage.reporting_today, 1);
    assert.equal(res.body.coverage.stale, 1);
    assert.equal(res.body.coverage.opted_out, 1);
    assert.equal(res.body.coverage.stale_users[0].name, 'Stale User');
    assert.equal(res.body.coverage.exempt_users[0].name, 'Exempt User');
    assert.ok(res.body.coverage.per_tool['claude-code']);
    assert.equal(res.body.users.length, 1);
    assert.equal(res.body.users[0].totals.cost_usd, 1.5);
    assert.equal(res.body.users[0].totals.session_count, 3);
  });

  it('P2 regression: cost_usd is null when any day had unknown pricing', async () => {
    // Simulate DB returning NULL cost_usd (what Tier-1 SQL returns when bool_or kicks in)
    const fakeQuery = async (sql) => {
      if (/user_status AS/.test(sql)) return { rows: [] };
      if (/FROM collector_heartbeat\s+GROUP BY tool/.test(sql)) return { rows: [] };
      if (/FROM users u\s+LEFT JOIN token_usage_daily/.test(sql)) {
        return { rows: [{ id: 1, name: 'U', email: 'u@x.com',
          cost_usd: null,   // partial period → null per policy
          input_tokens: '500', output_tokens: '300',
          cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
          message_count: 5, wall_seconds: 600, active_seconds: 300, session_count: 2 }] };
      }
      if (/FROM session_count\s+WHERE date/.test(sql)) return { rows: [] };
      throw new Error('unexpected SQL');
    };
    const app = buildApp({ queryFn: fakeQuery, user: { id: 9, role: 'admin' } });
    const res = await request(app, { path: '/api/usage/team-stats' });
    assert.equal(res.status, 200);
    assert.equal(res.body.users[0].totals.cost_usd, null,
      '有任一日 cost=NULL → 整筆回 null（不再 COALESCE→0）');
    // tokens 仍照算
    assert.equal(res.body.users[0].totals.input_tokens, '500');
  });

  it('P1 regression: Tier-2 session_count merges into user totals', async () => {
    const fakeQuery = async (sql) => {
      if (/user_status AS/.test(sql)) return { rows: [] };
      if (/FROM collector_heartbeat\s+GROUP BY tool/.test(sql)) return { rows: [] };
      if (/FROM users u\s+LEFT JOIN token_usage_daily/.test(sql)) {
        return { rows: [
          // User 1：有 Tier-1 資料
          { id: 1, name: 'U1', email: '1@x.com',
            cost_usd: 0.5, input_tokens: '10', output_tokens: '5',
            cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
            message_count: 3, wall_seconds: 600, active_seconds: 300, session_count: 2 },
          // User 2：只有 Tier-2（只用 Cursor/Antigravity）
          { id: 2, name: 'U2', email: '2@x.com',
            cost_usd: 0, input_tokens: '0', output_tokens: '0',
            cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
            message_count: 0, wall_seconds: 0, active_seconds: 0, session_count: 0 }
        ] };
      }
      if (/FROM session_count\s+WHERE date/.test(sql)) {
        return { rows: [
          { user_id: 1, tier2_sessions: 3, tier2_wall_seconds: 120 },
          { user_id: 2, tier2_sessions: 5, tier2_wall_seconds: 0 }
        ] };
      }
      throw new Error('unexpected SQL');
    };
    const app = buildApp({ queryFn: fakeQuery, user: { id: 9, role: 'admin' } });
    const res = await request(app, { path: '/api/usage/team-stats' });
    assert.equal(res.status, 200);
    const u1 = res.body.users.find((u) => u.user.id === 1);
    const u2 = res.body.users.find((u) => u.user.id === 2);
    // User 1：Tier-1 session=2 + Tier-2 session=3 = 5
    assert.equal(u1.totals.session_count, 5, 'Tier-1 + Tier-2 sessions 合併');
    assert.equal(u1.totals.wall_seconds, 720, '600 + 120');
    // User 2：只有 Tier-2
    assert.equal(u2.totals.session_count, 5,
      'Tier-2-only user 也要計入 session_count，不是 0');
  });

  it('period defaults apply when from/to omitted', async () => {
    let captured = [];
    const fakeQuery = async (sql, params) => {
      captured.push({ sql, params });
      if (/user_status AS/.test(sql)) return { rows: [] };
      if (/FROM collector_heartbeat\s+GROUP BY tool/.test(sql)) return { rows: [] };
      if (/FROM session_count\s+WHERE date/.test(sql)) return { rows: [] };
      return { rows: [] };
    };
    const app = buildApp({ queryFn: fakeQuery, user: { id: 1, role: 'super_admin' } });
    const res = await request(app, { path: '/api/usage/team-stats' });
    assert.equal(res.status, 200);
    assert.match(res.body.period.from, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(res.body.period.to, /^\d{4}-\d{2}-\d{2}$/);
  });
});
