import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createNarrativeRouter } from '../src/routes/me-narrative.js';

function fakeAuth(req, res, next) { req.user = { id: 1, name: 'Vin', role: 'super_admin' }; next(); }

function buildApp({ query }) {
  const router = createNarrativeRouter({ query, auth: fakeAuth });
  const app = express();
  app.use(express.json());
  app.use('/api/me/narrative', router);
  return app;
}

function get(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get(`http://127.0.0.1:${port}${path}`, (r) => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => {
          server.close();
          try { resolve({ status: r.statusCode, body: JSON.parse(body) }); }
          catch (e) { resolve({ status: r.statusCode, body }); }
        });
      }).on('error', reject);
    });
  });
}

function fakeQuery() {
  // returns empty rows for any query — endpoint should still return a complete shape
  return async () => ({ rows: [] });
}

describe('GET /api/me/narrative', () => {
  it('回傳 schema 含 range / generated_at / sections', async () => {
    const app = buildApp({ query: fakeQuery() });
    const res = await get(app, '/api/me/narrative?range=14d');
    assert.equal(res.status, 200);
    assert.equal(res.body.range, '14d');
    assert.ok(res.body.generated_at);
    assert.ok(res.body.sections);
  });

  it('sections 含全部 11 個 keys（即使資料空）', async () => {
    const app = buildApp({ query: fakeQuery() });
    const res = await get(app, '/api/me/narrative?range=14d');
    const expected = [
      'ranking', 'versions', 'daily', 'hourly', 'weekday',
      'event_types', 'compliance', 'update_health',
      'project_ranking', 'project_friction_raw', 'project_compliance',
    ];
    for (const k of expected) {
      assert.ok(Array.isArray(res.body.sections[k]), `sections.${k} should be array, got ${typeof res.body.sections[k]}`);
    }
  });

  it('range 缺省時 default 14d', async () => {
    const app = buildApp({ query: fakeQuery() });
    const res = await get(app, '/api/me/narrative');
    assert.equal(res.body.range, '14d');
  });

  it('SQL 失敗回 500 + 友善訊息', async () => {
    const app = buildApp({ query: async () => { throw new Error('db down'); } });
    const res = await get(app, '/api/me/narrative?range=14d');
    assert.equal(res.status, 500);
    assert.match(res.body.error, /敘事|narrative/i);
  });
});
