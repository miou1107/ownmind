import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { createStatsRouter, buildGrouping } = await import('../src/routes/usage/stats.js');

function buildApp({ queryFn, user }) {
  const fakeAuth = (req, _res, next) => { req.user = user; next(); };
  const router = createStatsRouter({ query: queryFn, auth: fakeAuth });
  const app = express();
  app.use(express.json());
  app.use('/api/usage/stats', router);
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

/**
 * Handy factory for the 4 SQL patterns stats.js now fires.
 */
function makeFakeStatsQuery({ tier1Totals, tier2Totals, tier1Series = [], tier2Series = [], isExempt = false } = {}) {
  return async (sql) => {
    // exemption check
    if (/FROM usage_tracking_exemption/.test(sql)) {
      return { rows: isExempt ? [{ '?column?': 1 }] : [] };
    }
    // Tier 1 totals
    if (/FROM token_usage_daily\s+WHERE user_id = \$1 AND date >= \$2 AND date <= \$3/.test(sql)
        && /COUNT\(DISTINCT session_id\)/.test(sql)
        && !/GROUP BY/.test(sql)) {
      return { rows: [tier1Totals || {
        cost_usd: 0, input_tokens: '0', output_tokens: '0',
        cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
        message_count: 0, wall_seconds: 0, active_seconds: 0, session_count: 0
      }] };
    }
    // Tier 2 totals
    if (/FROM session_count\s+WHERE user_id = \$1/.test(sql) && !/GROUP BY/.test(sql)) {
      return { rows: [tier2Totals || { tier2_sessions: 0, tier2_wall_seconds: 0 }] };
    }
    // Tier 1 series (has GROUP BY)
    if (/FROM token_usage_daily/.test(sql) && /GROUP BY/.test(sql)) {
      return { rows: tier1Series };
    }
    // Tier 2 series (by day or tool)
    if (/FROM session_count/.test(sql) && /GROUP BY/.test(sql)) {
      return { rows: tier2Series };
    }
    throw new Error('unexpected SQL: ' + sql.slice(0, 100));
  };
}

// ────────────────────────────────────────────────────────────
// buildGrouping
// ────────────────────────────────────────────────────────────

describe('buildGrouping', () => {
  it('supports day / tool / model / session', () => {
    assert.ok(buildGrouping('day').selectKey.includes('YYYY-MM-DD'));
    assert.equal(buildGrouping('tool').selectKey, 'tool');
    assert.match(buildGrouping('model').selectKey, /COALESCE/);
    assert.equal(buildGrouping('session').selectKey, 'session_id');
  });
  it('defaults to day grouping for unknown', () => {
    assert.ok(buildGrouping('whatever').selectKey.includes('YYYY-MM-DD'));
  });
});

// ────────────────────────────────────────────────────────────
// GET /api/usage/stats
// ────────────────────────────────────────────────────────────

describe('GET /api/usage/stats totals', () => {
  it('merges Tier-2 session_count + wall_seconds into totals', async () => {
    const app = buildApp({
      queryFn: makeFakeStatsQuery({
        tier1Totals: {
          cost_usd: 1.23, input_tokens: '100', output_tokens: '50',
          cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
          message_count: 7, wall_seconds: 600, active_seconds: 300, session_count: 2
        },
        tier2Totals: { tier2_sessions: 4, tier2_wall_seconds: 120 }
      }),
      user: { id: 1, name: 'Vin', email: 'v@x.com' }
    });
    const res = await request(app, { path: '/api/usage/stats' });
    assert.equal(res.status, 200);
    // Tier-1 2 + Tier-2 4 = 6
    assert.equal(res.body.totals.session_count, 6);
    // 600 + 120
    assert.equal(res.body.totals.wall_seconds, 720);
    assert.equal(res.body.totals.cost_usd, 1.23);
  });

  it('P1 regression: user with only Tier-2 usage shows non-zero session_count', async () => {
    const app = buildApp({
      queryFn: makeFakeStatsQuery({
        tier1Totals: {
          cost_usd: 0, input_tokens: '0', output_tokens: '0',
          cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
          message_count: 0, wall_seconds: 0, active_seconds: 0, session_count: 0
        },
        tier2Totals: { tier2_sessions: 5, tier2_wall_seconds: 0 }
      }),
      user: { id: 1, name: 'Vin', email: 'v@x.com' }
    });
    const res = await request(app, { path: '/api/usage/stats' });
    assert.equal(res.body.totals.session_count, 5,
      'Tier-2-only user 必須看到 Cursor/Antigravity 的 session 計數');
  });

  it('P2 regression: cost_usd=null propagates through totals (not coerced to 0)', async () => {
    const app = buildApp({
      queryFn: makeFakeStatsQuery({
        tier1Totals: {
          cost_usd: null,   // SQL 回 null 代表有任一日 pricing 缺漏
          input_tokens: '100', output_tokens: '50',
          cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
          message_count: 7, wall_seconds: 600, active_seconds: 300, session_count: 2
        },
        tier2Totals: { tier2_sessions: 0, tier2_wall_seconds: 0 }
      }),
      user: { id: 1, name: 'Vin', email: 'v@x.com' }
    });
    const res = await request(app, { path: '/api/usage/stats' });
    assert.equal(res.body.totals.cost_usd, null,
      'cost_usd=null 必須保留；不要被 COALESCE→0 偽裝成完整總額');
    // Tokens 仍要照數顯示
    assert.equal(res.body.totals.input_tokens, '100');
  });

  it('series group_by=tool merges Tier-2-only tools into output', async () => {
    const app = buildApp({
      queryFn: makeFakeStatsQuery({
        tier1Series: [
          { key: 'claude-code', cost_usd: 1.5, input_tokens: '100', output_tokens: '50',
            cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
            message_count: 5, wall_seconds: 600, active_seconds: 300 }
        ],
        tier2Series: [
          { key: 'cursor', session_count: 3, wall_seconds: 0 },
          { key: 'antigravity', session_count: 5, wall_seconds: 0 }
        ]
      }),
      user: { id: 1, name: 'Vin', email: 'v@x.com' }
    });
    const res = await request(app, { path: '/api/usage/stats?group_by=tool' });
    const keys = res.body.series.map((s) => s.key).sort();
    assert.deepEqual(keys, ['antigravity', 'claude-code', 'cursor'],
      'Tier-2-only tools 必須出現在 series');
    const cursor = res.body.series.find((s) => s.key === 'cursor');
    assert.equal(cursor.session_count, 3);
    assert.equal(cursor.cost_usd, 0, 'Tier-2 tool 無 token → cost 為 0（非 null）');
  });

  it('series group_by=day merges Tier-1 + Tier-2 on overlapping dates', async () => {
    const app = buildApp({
      queryFn: makeFakeStatsQuery({
        tier1Series: [
          { key: '2026-04-21', cost_usd: 1.0, input_tokens: '100', output_tokens: '50',
            cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
            message_count: 3, wall_seconds: 600, active_seconds: 300 }
        ],
        tier2Series: [
          { key: '2026-04-21', session_count: 2, wall_seconds: 60 },
          { key: '2026-04-22', session_count: 1, wall_seconds: 0 }
        ]
      }),
      user: { id: 1, name: 'Vin', email: 'v@x.com' }
    });
    const res = await request(app, { path: '/api/usage/stats?group_by=day' });
    const d1 = res.body.series.find((s) => s.key === '2026-04-21');
    const d2 = res.body.series.find((s) => s.key === '2026-04-22');
    assert.equal(d1.wall_seconds, 660, '600 + 60');
    assert.equal(d1.session_count, 5, 'Tier-1 message_count=3 + Tier-2 sessions=2');
    assert.ok(d2, 'Tier-2-only 日期也要出現');
    assert.equal(d2.session_count, 1);
  });

  it('P2 regression: series group_by=tool with mixed-known/unknown pricing → cost_usd=null per group', async () => {
    const app = buildApp({
      queryFn: makeFakeStatsQuery({
        tier1Series: [
          { key: 'claude-code', cost_usd: 1.0, input_tokens: '100', output_tokens: '50',
            cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
            message_count: 3, wall_seconds: 600, active_seconds: 300 },
          { key: 'codex', cost_usd: null, input_tokens: '50', output_tokens: '25',
            cache_creation_tokens: '0', cache_read_tokens: '0', reasoning_tokens: '0',
            message_count: 2, wall_seconds: 120, active_seconds: 60 }
        ]
      }),
      user: { id: 1, name: 'Vin', email: 'v@x.com' }
    });
    const res = await request(app, { path: '/api/usage/stats?group_by=tool' });
    const codex = res.body.series.find((s) => s.key === 'codex');
    assert.equal(codex.cost_usd, null,
      'codex tool 該期間有 unknown pricing → cost_usd 應為 null');
    const cc = res.body.series.find((s) => s.key === 'claude-code');
    assert.equal(cc.cost_usd, 1.0, 'claude-code pricing 已知 → cost_usd 照常');
  });

  it('includes is_exempt flag in response', async () => {
    const app = buildApp({
      queryFn: makeFakeStatsQuery({ isExempt: true }),
      user: { id: 1, name: 'Vin', email: 'v@x.com' }
    });
    const res = await request(app, { path: '/api/usage/stats' });
    assert.equal(res.body.is_exempt, true);
  });
});
