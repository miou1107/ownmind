import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { pickPricing, computeCost } = await import('../src/utils/pricing-lookup.js');
const { createPricingRouter } = await import('../src/routes/usage/pricing.js');

describe('pickPricing — effective_date lookup', () => {
  const rows = [
    { tool: 'claude-code', model: 'claude-opus-4-7',
      input_per_1m: 15, output_per_1m: 75, cache_write_per_1m: 18.75, cache_read_per_1m: 1.5,
      effective_date: '2024-01-01' },
    { tool: 'claude-code', model: 'claude-opus-4-7',
      input_per_1m: 20, output_per_1m: 100, cache_write_per_1m: 25, cache_read_per_1m: 2,
      effective_date: '2026-03-01' },
    { tool: 'claude-code', model: 'claude-sonnet-4-6',
      input_per_1m: 3, output_per_1m: 15, cache_write_per_1m: 3.75, cache_read_per_1m: 0.3,
      effective_date: '2024-01-01' },
    { tool: 'codex', model: 'gpt-5',
      input_per_1m: 10, output_per_1m: 30, cache_write_per_1m: 12.5, cache_read_per_1m: 1,
      effective_date: '2024-01-01' }
  ];

  it('picks the latest effective_date row at-or-before the target date', () => {
    const p1 = pickPricing(rows, 'claude-code', 'claude-opus-4-7', '2026-02-01');
    assert.equal(p1.effective_date, '2024-01-01',
      'before price change should use 2024-01-01 row');

    const p2 = pickPricing(rows, 'claude-code', 'claude-opus-4-7', '2026-03-01');
    assert.equal(p2.effective_date, '2026-03-01',
      'on the price change day should pick new row');

    const p3 = pickPricing(rows, 'claude-code', 'claude-opus-4-7', '2026-04-21');
    assert.equal(p3.effective_date, '2026-03-01',
      'after price change should use new row');
  });

  it('returns null when no row matches tool + model', () => {
    const p = pickPricing(rows, 'claude-code', 'unknown-model', '2026-04-21');
    assert.equal(p, null);
  });

  it('returns null when all rows have effective_date after target', () => {
    const p = pickPricing(rows, 'claude-code', 'claude-opus-4-7', '2023-12-31');
    assert.equal(p, null);
  });

  it('handles Date objects as input', () => {
    const p = pickPricing(rows, 'codex', 'gpt-5', new Date('2026-04-21'));
    assert.equal(p.tool, 'codex');
    assert.equal(p.model, 'gpt-5');
  });

  it('returns null on empty or non-array input', () => {
    assert.equal(pickPricing([], 'x', 'y', '2026-01-01'), null);
    assert.equal(pickPricing(null, 'x', 'y', '2026-01-01'), null);
  });

  it('does not match wrong tool for same model name', () => {
    const mixed = [
      { tool: 'codex', model: 'shared-name',
        input_per_1m: 1, output_per_1m: 2,
        cache_write_per_1m: 0, cache_read_per_1m: 0, effective_date: '2024-01-01' },
      { tool: 'claude-code', model: 'shared-name',
        input_per_1m: 9, output_per_1m: 9,
        cache_write_per_1m: 0, cache_read_per_1m: 0, effective_date: '2024-01-01' }
    ];
    const p = pickPricing(mixed, 'codex', 'shared-name', '2026-04-21');
    assert.equal(p.input_per_1m, 1);
  });
});

describe('computeCost', () => {
  const pricing = {
    input_per_1m: 15, output_per_1m: 75,
    cache_write_per_1m: 18.75, cache_read_per_1m: 1.5
  };

  it('returns null when pricing is null', () => {
    assert.equal(computeCost(null, { input_tokens: 100 }), null);
  });

  it('computes cost = sum(tokens * price) / 1M', () => {
    const cost = computeCost(pricing, {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_tokens: 1_000_000,
      cache_read_tokens: 1_000_000
    });
    // 15 + 75 + 18.75 + 1.5 = 110.25 USD for 1M of each
    assert.equal(Number(cost.toFixed(6)), 110.25);
  });

  it('treats missing / null token fields as 0', () => {
    const cost = computeCost(pricing, { input_tokens: 1_000_000 });
    assert.equal(Number(cost.toFixed(6)), 15);

    const cost2 = computeCost(pricing, {
      input_tokens: null, output_tokens: 1_000_000,
      cache_creation_tokens: undefined, cache_read_tokens: null
    });
    assert.equal(Number(cost2.toFixed(6)), 75);
  });

  it('counts reasoning_tokens at output_per_1m rate', () => {
    const cost = computeCost(pricing, {
      reasoning_tokens: 1_000_000
    });
    assert.equal(Number(cost.toFixed(6)), 75);
  });

  it('handles realistic small-scale event (Vin sample 60521 tokens)', () => {
    const cost = computeCost(pricing, {
      input_tokens: 6,
      output_tokens: 1163,
      cache_creation_tokens: 59352,
      cache_read_tokens: 0
    });
    // 6 * 15 + 1163 * 75 + 59352 * 18.75 = 90 + 87225 + 1112850 = 1200165
    // / 1M = 1.200165 USD
    assert.equal(Number(cost.toFixed(6)), 1.200165);
  });
});

describe('pricing-lookup — edge cases', () => {
  it('picks the correct row when multiple effective_dates sit on the same day', () => {
    const rows = [
      { tool: 'a', model: 'b', input_per_1m: 1, output_per_1m: 1,
        cache_write_per_1m: 0, cache_read_per_1m: 0, effective_date: '2024-01-01' },
      { tool: 'a', model: 'b', input_per_1m: 2, output_per_1m: 2,
        cache_write_per_1m: 0, cache_read_per_1m: 0, effective_date: '2025-01-01' },
      { tool: 'a', model: 'b', input_per_1m: 3, output_per_1m: 3,
        cache_write_per_1m: 0, cache_read_per_1m: 0, effective_date: '2026-01-01' }
    ];
    const picked = pickPricing(rows, 'a', 'b', '2025-06-15');
    assert.equal(picked.input_per_1m, 2, 'should pick mid range not latest');
  });

  it('breaks ties by id DESC when two rows share effective_date (defense-in-depth)', () => {
    // UNIQUE(tool, model, effective_date) 理論上擋同日；這裡測 helper 本身的 tiebreaker
    const rows = [
      { id: 10, tool: 'a', model: 'b', input_per_1m: 1,
        output_per_1m: 0, cache_write_per_1m: 0, cache_read_per_1m: 0,
        effective_date: '2025-01-01' },
      { id: 20, tool: 'a', model: 'b', input_per_1m: 99,
        output_per_1m: 0, cache_write_per_1m: 0, cache_read_per_1m: 0,
        effective_date: '2025-01-01' }
    ];
    const picked = pickPricing(rows, 'a', 'b', '2025-06-15');
    assert.equal(picked.id, 20, 'same-date tie → higher id wins');
  });

  it('normalizes pg DATE-as-UTC-midnight correctly regardless of host TZ', () => {
    // pg driver 回傳 DATE 時會產生 UTC 午夜 Date 物件
    const pgDate = new Date(Date.UTC(2025, 2, 1));  // 2025-03-01 UTC midnight
    const rows = [
      { id: 1, tool: 't', model: 'm', input_per_1m: 5,
        output_per_1m: 0, cache_write_per_1m: 0, cache_read_per_1m: 0,
        effective_date: pgDate }
    ];
    // 查 2025-03-01 應該命中（不因 local TZ 被誤算到前一天）
    const picked = pickPricing(rows, 't', 'm', '2025-03-01');
    assert.equal(picked.input_per_1m, 5);
    // 查 2025-02-28 不應命中
    const miss = pickPricing(rows, 't', 'm', '2025-02-28');
    assert.equal(miss, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Route-level CRUD tests — 用 mock.module 替換 db.query，不依賴真實 DB
// ═══════════════════════════════════════════════════════════════════════

function buildApp({ queryFn, user }) {
  const fakeAuth = (req, _res, next) => { req.user = user; next(); };
  const fakeSuperAdmin = (req, res, next) => {
    req.user = user;
    if (!user || user.role !== 'super_admin') {
      return res.status(403).json({ error: '需要超級管理員權限' });
    }
    next();
  };
  const router = createPricingRouter({
    query: queryFn,
    auth: fakeAuth,
    superAdminAuth: fakeSuperAdmin
  });
  const app = express();
  app.use(express.json());
  app.use('/api/usage/pricing', router);
  return app;
}

async function request(app, { method, path, body, headers }) {
  return await new Promise((resolve, reject) => {
    const req = {
      method, url: path, path,
      headers: { 'content-type': 'application/json', ...(headers || {}) },
      body: body || {}
    };
    const chunks = [];
    const res = {
      statusCode: 200,
      _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
      getHeader(k) { return this._headers[k]; },
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
      send(payload) { resolve({ status: this.statusCode, body: payload }); },
      end() { resolve({ status: this.statusCode, body: null }); }
    };
    try {
      app.handle(req, res, (err) => {
        if (err) reject(err);
        else resolve({ status: res.statusCode, body: null });
      });
    } catch (e) { reject(e); }
  });
}

describe('POST /api/usage/pricing — route validation + auth', () => {
  it('rejects non super_admin with 403', async () => {
    const app = buildApp({
      queryFn: async () => { throw new Error('DB should not be hit'); },
      user: { id: 2, role: 'admin' }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/pricing',
      body: { tool: 't', model: 'm', input_per_1m: 1, output_per_1m: 2, effective_date: '2026-01-01' }
    });
    assert.equal(res.status, 403);
  });

  it('rejects missing required fields with 400', async () => {
    const app = buildApp({
      queryFn: async () => { throw new Error('DB should not be hit'); },
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/pricing',
      body: { tool: 'claude-code' } // 缺 model / input / output / effective_date
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /必填欄位缺少/);
  });

  it('rejects invalid effective_date format', async () => {
    const app = buildApp({
      queryFn: async () => { throw new Error('DB should not be hit'); },
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/pricing',
      body: { tool: 't', model: 'm', input_per_1m: 1, output_per_1m: 2, effective_date: '2026/01/01' }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /effective_date/);
  });

  it('rejects negative prices', async () => {
    const app = buildApp({
      queryFn: async () => { throw new Error('DB should not be hit'); },
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/pricing',
      body: { tool: 't', model: 'm', input_per_1m: -1, output_per_1m: 2, effective_date: '2026-01-01' }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /非負數/);
  });

  it('rejects non-numeric prices with a distinct message', async () => {
    const app = buildApp({
      queryFn: async () => { throw new Error('DB should not be hit'); },
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/pricing',
      body: { tool: 't', model: 'm', input_per_1m: 'abc', output_per_1m: 2, effective_date: '2026-01-01' }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /需為數字/);
  });

  it('inserts successfully with valid super_admin request', async () => {
    let capturedSql, capturedParams;
    const app = buildApp({
      queryFn: async (sql, params) => {
        capturedSql = sql;
        capturedParams = params;
        return {
          rows: [{
            id: 42, tool: params[0], model: params[1],
            input_per_1m: params[2], output_per_1m: params[3],
            cache_write_per_1m: params[4], cache_read_per_1m: params[5],
            effective_date: params[6], notes: params[7],
            created_at: new Date().toISOString()
          }]
        };
      },
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/pricing',
      body: {
        tool: 'claude-code', model: 'claude-opus-4-7',
        input_per_1m: 20, output_per_1m: 100,
        cache_write_per_1m: 25, cache_read_per_1m: 2,
        effective_date: '2026-03-01', notes: 'new pricing'
      }
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.id, 42);
    assert.match(capturedSql, /INSERT INTO model_pricing/);
    assert.equal(capturedParams[0], 'claude-code');
    assert.equal(capturedParams[6], '2026-03-01');
  });

  it('returns 409 on UNIQUE conflict', async () => {
    const app = buildApp({
      queryFn: async () => { const e = new Error('dup'); e.code = '23505'; throw e; },
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/usage/pricing',
      body: { tool: 't', model: 'm', input_per_1m: 1, output_per_1m: 2, effective_date: '2026-01-01' }
    });
    assert.equal(res.status, 409);
  });
});

describe('GET /api/usage/pricing — authenticated users can read', () => {
  it('returns all pricing rows as JSON', async () => {
    const mockRows = [
      { id: 1, tool: 'claude-code', model: 'claude-opus-4', input_per_1m: 15 },
      { id: 2, tool: 'codex', model: 'gpt-5', input_per_1m: 10 }
    ];
    const app = buildApp({
      queryFn: async (sql) => {
        assert.match(sql, /SELECT .* FROM model_pricing/s);
        return { rows: mockRows };
      },
      user: { id: 5, role: 'user' }
    });
    const res = await request(app, { method: 'GET', path: '/api/usage/pricing' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, mockRows);
  });
});
