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
  it('response schema includes range / generated_at / sections', async () => {
    const app = buildApp({ query: fakeQuery() });
    const res = await get(app, '/api/me/narrative?range=14d');
    assert.equal(res.status, 200);
    assert.equal(res.body.range, '14d');
    assert.ok(res.body.generated_at);
    assert.ok(res.body.sections);
  });

  it('sections includes all 11 keys (even when data is empty)', async () => {
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

  it('defaults to 14d when range is omitted', async () => {
    const app = buildApp({ query: fakeQuery() });
    const res = await get(app, '/api/me/narrative');
    assert.equal(res.body.range, '14d');
  });

  it('SQL failure returns 500 + a friendly message', async () => {
    const app = buildApp({ query: async () => { throw new Error('db down'); } });
    const res = await get(app, '/api/me/narrative?range=14d');
    assert.equal(res.status, 500);
    assert.match(res.body.error, /敘事|narrative/i);
  });
});

describe('GET /api/me/narrative/insights', () => {
  it('returns 503 when LLM_SWITCH_API_KEY is not set', async () => {
    const router = createNarrativeRouter({
      query: async () => ({ rows: [] }),
      auth: fakeAuth,
      env: {},
    });
    const app = express();
    app.use('/api/me/narrative', router);
    const res = await get(app, '/api/me/narrative/insights?range=14d');
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'no_api_key');
  });

  it('uses the cache when the data hash matches; the second call does not hit the LLM', async () => {
    let llmCalls = 0;
    const fakeLLM = async () => {
      llmCalls++;
      return {
        summary_one_line: 'x',
        section_explanations: {},
        project_friction: {},
        insights_for_admin: [],
        next_actions: [],
      };
    };
    const router = createNarrativeRouter({
      query: async () => ({ rows: [] }),
      auth: fakeAuth,
      llmCall: fakeLLM,
      env: { LLM_SWITCH_API_KEY: 'sk-test' },
    });
    const app = express();
    app.use('/api/me/narrative', router);

    const r1 = await get(app, '/api/me/narrative/insights?range=14d');
    assert.equal(r1.status, 200);
    assert.equal(r1.body.cached, false);

    const r2 = await get(app, '/api/me/narrative/insights?range=14d');
    assert.equal(r2.body.cached, true);

    assert.equal(llmCalls, 1, 'LLM should be called only once');
  });

  it('LLM failure returns 502', async () => {
    const router = createNarrativeRouter({
      query: async () => ({ rows: [] }),
      auth: fakeAuth,
      llmCall: async () => { throw new Error('upstream timeout'); },
      env: { LLM_SWITCH_API_KEY: 'sk-test' },
    });
    const app = express();
    app.use('/api/me/narrative', router);
    const res = await get(app, '/api/me/narrative/insights?range=14d');
    assert.equal(res.status, 502);
  });

  it('PII (email) is redacted before being sent to the LLM', async () => {
    let received;
    const fakeLLM = async ({ messages }) => {
      received = messages[1].content;
      return {
        summary_one_line: '', section_explanations: {}, project_friction: {},
        insights_for_admin: [], next_actions: [],
      };
    };
    const router = createNarrativeRouter({
      query: async () => ({ rows: [{ name: 'alice@example.com', friction: 'see admin@foo.bar' }] }),
      auth: fakeAuth,
      llmCall: fakeLLM,
      env: { LLM_SWITCH_API_KEY: 'sk-test' },
    });
    const app = express();
    app.use('/api/me/narrative', router);
    await get(app, '/api/me/narrative/insights?range=14d');
    assert.doesNotMatch(received, /alice@example\.com/);
    assert.doesNotMatch(received, /admin@foo\.bar/);
    assert.match(received, /\[email\]/);
  });
});
