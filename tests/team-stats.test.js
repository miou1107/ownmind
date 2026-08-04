import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { createTeamStatsRouter, parseParams, buildCoverage } =
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

// v1.26.58 — coverage used to count collector_heartbeat rows, so a collector that
// connected but never shipped a byte counted as covered. Measured on production
// 2026-07-30: it claimed 8 of 9 members were reporting while three of them had no
// usage data at all. The number now comes from the same `users` array the table is
// built from, so the panel and the ranking cannot disagree.
describe('buildCoverage', () => {
  const user = (id, hasData) => ({
    user: { id, name: `U${id}`, email: `${id}@x.com` },
    totals: { has_usage_data: hasData },
  });

  it('counts members with usage data, not collectors that said hello', () => {
    const c = buildCoverage([user(1, true), user(2, false), user(3, true)], new Set());
    assert.equal(c.total_users, 3);
    assert.equal(c.measured, 2);
    assert.equal(c.unmeasured, 1);
    assert.equal(c.opted_out, 0);
    assert.deepEqual(c.unmeasured_users.map((u) => u.id), [2]);
  });

  it('names who is missing, because a count alone cannot be chased', () => {
    const c = buildCoverage([user(1, false), user(2, true)], new Set());
    assert.deepEqual(c.unmeasured_users, [{ id: 1, name: 'U1', email: '1@x.com' }]);
  });

  it('separates the deliberately exempt from the unexplained gap', () => {
    const c = buildCoverage([user(1, false), user(2, false)], new Set([2]));
    assert.equal(c.unmeasured, 1, 'only the non-exempt one is a gap to chase');
    assert.equal(c.opted_out, 1);
    assert.deepEqual(c.unmeasured_users.map((u) => u.id), [1]);
    assert.deepEqual(c.exempt_users.map((u) => u.id), [2]);
  });

  // An exemption stops future ingestion; it does not delete what was already
  // collected. A member exempted mid-window still has real data in it, and
  // calling that "no data" would understate the coverage we actually have.
  it('an exempt member who does have data in the window counts as measured', () => {
    const c = buildCoverage([user(1, true)], new Set([1]));
    assert.equal(c.measured, 1);
    assert.equal(c.opted_out, 0);
    assert.equal(c.exempt_users.length, 0);
  });

  it('every member lands in exactly one bucket', () => {
    const users = [user(1, true), user(2, false), user(3, false), user(4, true)];
    const c = buildCoverage(users, new Set([3]));
    assert.equal(c.measured + c.unmeasured + c.opted_out, c.total_users,
      'the three buckets must partition the team, or the denominator is a lie');
  });

  it('an empty team is not a division by zero', () => {
    const c = buildCoverage([], new Set());
    assert.equal(c.total_users, 0);
    assert.equal(c.measured, 0);
    assert.deepEqual(c.unmeasured_users, []);
  });
});

describe('GET /api/usage/team-stats (admin+)', () => {
  it('rejects non-admin with 403', async () => {
    const app = buildApp({ queryFn: async () => { throw new Error('no-db'); }, user: { id: 2, role: 'user' } });
    const res = await request(app, { path: '/api/usage/team-stats' });
    assert.equal(res.status, 403);
  });

  it('returns coverage + users for admin', async () => {
    // Three members: one reporting, one silent, one exempt and silent.
    const fakeQuery = async (sql) => {
      if (/FROM usage_tracking_exemption/.test(sql)) {
        return { rows: [{ user_id: 3 }] };
      }
      if (/FROM users u\s+LEFT JOIN token_usage_daily/.test(sql)) {
        return { rows: [
          { id: 1, name: 'Active User', email: 'a@x.com',
            cost_usd: 1.5, input_tokens: '100', output_tokens: '50',
            cache_creation_tokens: '0', cache_read_tokens: '10', reasoning_tokens: '5',
            message_count: 10, wall_seconds: 3600, active_seconds: 1800, session_count: 3,
            has_tier1_data: true },
          { id: 2, name: 'Silent User', email: 'b@x.com',
            cost_usd: 0, input_tokens: '0', output_tokens: '0',
            cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
            message_count: 0, wall_seconds: 0, active_seconds: 0, session_count: 0,
            has_tier1_data: false },
          { id: 3, name: 'Exempt User', email: 'c@x.com',
            cost_usd: 0, input_tokens: '0', output_tokens: '0',
            cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
            message_count: 0, wall_seconds: 0, active_seconds: 0, session_count: 0,
            has_tier1_data: false }
        ] };
      }
      if (/FROM session_count\s+WHERE date/.test(sql)) {
        // Tier-2 aggregate per user (this test has no Cursor/Antigravity data)
        return { rows: [] };
      }
      throw new Error('unexpected SQL: ' + sql);
    };
    const app = buildApp({ queryFn: fakeQuery, user: { id: 9, role: 'admin' } });
    const res = await request(app, { path: '/api/usage/team-stats?from=2026-04-01&to=2026-04-30' });
    assert.equal(res.status, 200);
    assert.equal(res.body.coverage.total_users, 3);
    assert.equal(res.body.coverage.measured, 1);
    assert.equal(res.body.coverage.unmeasured, 1);
    assert.equal(res.body.coverage.opted_out, 1);
    assert.equal(res.body.coverage.unmeasured_users[0].name, 'Silent User');
    assert.equal(res.body.coverage.exempt_users[0].name, 'Exempt User');
    assert.equal(res.body.users.length, 3);
    assert.equal(res.body.users[0].totals.cost_usd, 1.5);
    assert.equal(res.body.users[0].totals.session_count, 3);
  });

  it('P2 regression: user with no activity shows cost_usd=0 (not null from LEFT JOIN)', async () => {
    // Returning cost_usd: 0 means bool_or correctly excluded the NULL rows from the LEFT JOIN
    // (staging once returned null because bool_or(NULL IS NULL)=true caused a misjudgment)
    const fakeQuery = async (sql) => {
      if (/FROM usage_tracking_exemption/.test(sql)) return { rows: [] };
      if (/FROM users u\s+LEFT JOIN token_usage_daily/.test(sql)) {
        return { rows: [{ id: 1, name: 'Fresh User', email: 'fresh@x.com',
          cost_usd: 0, input_tokens: '0', output_tokens: '0',
          cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
          message_count: 0, wall_seconds: 0, active_seconds: 0, session_count: 0 }] };
      }
      if (/FROM session_count\s+WHERE date/.test(sql)) return { rows: [] };
      throw new Error('unexpected SQL');
    };
    const app = buildApp({ queryFn: fakeQuery, user: { id: 9, role: 'admin' } });
    const res = await request(app, { path: '/api/usage/team-stats' });
    assert.equal(res.status, 200);
    assert.equal(res.body.users[0].totals.cost_usd, 0,
      '完全沒 activity 的 user 應顯示 0，不是 null');
  });

  it('P2 regression: cost_usd is null when any day had unknown pricing', async () => {
    // Simulate DB returning NULL cost_usd (what Tier-1 SQL returns when bool_or kicks in)
    const fakeQuery = async (sql) => {
      if (/FROM usage_tracking_exemption/.test(sql)) return { rows: [] };
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
    // tokens are still counted
    assert.equal(res.body.users[0].totals.input_tokens, '500');
  });

  it('P1 regression: Tier-2 session_count merges into user totals', async () => {
    const fakeQuery = async (sql) => {
      if (/FROM usage_tracking_exemption/.test(sql)) return { rows: [] };
      if (/FROM users u\s+LEFT JOIN token_usage_daily/.test(sql)) {
        return { rows: [
          // User 1: has Tier-1 data
          { id: 1, name: 'U1', email: '1@x.com',
            cost_usd: 0.5, input_tokens: '10', output_tokens: '5',
            cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
            message_count: 3, wall_seconds: 600, active_seconds: 300, session_count: 2 },
          // User 2: Tier-2 only (uses only Cursor/Antigravity)
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
    // User 1: Tier-1 session=2 + Tier-2 session=3 = 5
    assert.equal(u1.totals.session_count, 5, 'Tier-1 + Tier-2 sessions 合併');
    assert.equal(u1.totals.wall_seconds, 720, '600 + 120');
    // User 2: Tier-2 only
    assert.equal(u2.totals.session_count, 5,
      'Tier-2-only user 也要計入 session_count，不是 0');
  });

  // v1.26.56 — the LEFT JOIN means every member comes back as a row whether or
  // not they reported anything, so the payload has to say which. Without this
  // the console rendered "0 tokens / 0 次對話" for members it had no data for,
  // which is the failure umbrella Requirement 7 exists to stop.
  it('has_usage_data distinguishes a reported zero from no data at all', async () => {
    const fakeQuery = async (sql) => {
      if (/FROM usage_tracking_exemption/.test(sql)) return { rows: [] };
      if (/FROM users u\s+LEFT JOIN token_usage_daily/.test(sql)) {
        return { rows: [
          // Reported, and the numbers happen to be zero.
          { id: 1, name: 'Quiet', email: 'q@x.com', cost_usd: 0,
            input_tokens: '0', output_tokens: '0', cache_creation_tokens: '0',
            cache_read_tokens: '0', reasoning_tokens: '0', message_count: 0,
            wall_seconds: 0, active_seconds: 0, session_count: 0, has_tier1_data: true },
          // Never reported. `d.id IS NOT NULL` is never itself NULL, so bool_or
          // over the single non-matching LEFT JOIN row is FALSE — verified
          // against postgres:16 rather than assumed, because the three-valued
          // reading (null) is the plausible-but-wrong one.
          { id: 2, name: 'Silent', email: 's@x.com', cost_usd: 0,
            input_tokens: '0', output_tokens: '0', cache_creation_tokens: '0',
            cache_read_tokens: '0', reasoning_tokens: '0', message_count: 0,
            wall_seconds: 0, active_seconds: 0, session_count: 0, has_tier1_data: false },
          // Defensive: should postgres ever hand back null here, it must still
          // read as "no data", not as measured.
          { id: 4, name: 'Null Flag', email: 'n@x.com', cost_usd: 0,
            input_tokens: '0', output_tokens: '0', cache_creation_tokens: '0',
            cache_read_tokens: '0', reasoning_tokens: '0', message_count: 0,
            wall_seconds: 0, active_seconds: 0, session_count: 0, has_tier1_data: null },
          // No tier-1 row, but Cursor sessions in tier 2 — still measured.
          { id: 3, name: 'Cursor Only', email: 'c@x.com', cost_usd: 0,
            input_tokens: '0', output_tokens: '0', cache_creation_tokens: '0',
            cache_read_tokens: '0', reasoning_tokens: '0', message_count: 0,
            wall_seconds: 0, active_seconds: 0, session_count: 0, has_tier1_data: null },
        ] };
      }
      if (/FROM session_count\s+WHERE date/.test(sql)) {
        return { rows: [{ user_id: 3, tier2_sessions: 4, tier2_wall_seconds: 300 }] };
      }
      throw new Error('unexpected SQL: ' + sql);
    };
    const app = buildApp({ queryFn: fakeQuery, user: { id: 9, role: 'admin' } });
    const res = await request(app, { path: '/api/usage/team-stats?from=2026-04-01&to=2026-04-30' });
    assert.equal(res.status, 200);
    const byId = Object.fromEntries(res.body.users.map((u) => [u.user.id, u.totals]));
    assert.equal(byId[1].has_usage_data, true, 'a reported zero is measured');
    assert.equal(byId[2].has_usage_data, false, 'no row in either tier is not a zero');
    assert.equal(byId[3].has_usage_data, true, 'tier-2-only still counts as measured');
    assert.equal(byId[4].has_usage_data, false, 'a null flag must not read as measured');
  });

  it('period defaults apply when from/to omitted', async () => {
    let captured = [];
    const fakeQuery = async (sql, params) => {
      captured.push({ sql, params });
      if (/FROM usage_tracking_exemption/.test(sql)) return { rows: [] };
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
