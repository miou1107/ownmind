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

// v1.26.137 — the condensing has to be wired into the route, not merely available.
//
// The previous round's lesson: a unit test of the pure helper stays green while the thing
// that was broken comes back. So these drive the real router and assert on what actually
// reached the model. Delete the `condenseSections` call in the route and they go red.
describe('GET /api/me/narrative/insights — oversized payloads', () => {
  /** A query stub whose friction rows are large enough to blow the 40 KiB ceiling. */
  function bigQuery() {
    const long = '這是一段逐字記下來的踩坑描述，會很長很長。'.repeat(60);
    return async (sql) => {
      // Only the friction query returns the long rows. An earlier version of this stub
      // matched the project-ranking query too and stuffed it with the same text, which is
      // not a shape production produces — but it did surface that the targeted steps alone
      // leave an unanticipated section unhandled, which is why the last-resort trim exists.
      if (/friction/i.test(sql)) {
        return { rows: Array.from({ length: 60 }, (_, i) => ({ project_key: `p${i % 6}`, friction: long })) };
      }
      if (/collector_heartbeat/i.test(sql)) {
        return {
          rows: Array.from({ length: 44 }, (_, i) => ({
            user_id: (i % 9) + 1,
            tool: ['claude-code', 'codex', 'cursor', 'antigravity', 'opencode'][i % 5],
            version: i % 7 === 0 ? '1.26.27' : '1.26.135',
            last_reported_at: '2026-08-10T00:00:00.000Z',
            machine: `machine-${(i % 9) + 1}`,
          })),
        };
      }
      return { rows: [] };
    };
  }

  function appWithCapture({ query }) {
    const seen = {};
    const router = createNarrativeRouter({
      query,
      auth: fakeAuth,
      env: { LLM_SWITCH_API_KEY: 'test-key' },
      llmCall: async ({ messages }) => {
        seen.messages = messages;
        seen.bytes = Buffer.byteLength(JSON.stringify({
          model: 'auto', response_format: { type: 'json_object' },
          temperature: 0.3, max_tokens: 2000, messages,
        }), 'utf8');
        return { summary_one_line: 'ok', insights_for_admin: [], next_actions: [] };
      },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/me/narrative', router);
    return { app, seen };
  }

  it('what reaches the model is under the size the upstream refuses', async () => {
    const { app, seen } = appWithCapture({ query: bigQuery() });
    const res = await get(app, '/api/me/narrative/insights?range=30d');
    assert.equal(res.status, 200);
    // 39,600 bytes was measured going through and 41,025 measured refused.
    assert.ok(seen.bytes < 39_600, `sent ${seen.bytes} bytes, which the upstream refuses`);
  });

  it('the reply says which parts were summarised', async () => {
    const { app } = appWithCapture({ query: bigQuery() });
    const res = await get(app, '/api/me/narrative/insights?range=30d');
    assert.ok(Array.isArray(res.body.condensed) && res.body.condensed.length > 0,
      'a condensed report presented as a complete one is the failure mode worth avoiding');
  });

  it('a payload that already fits is sent whole, with nothing added to the reply', async () => {
    const { app, seen } = appWithCapture({ query: fakeQuery() });
    const res = await get(app, '/api/me/narrative/insights?range=7d');
    assert.equal(res.status, 200);
    assert.equal(res.body.condensed, undefined, 'the range that always worked must be untouched');
    // The system prompt legitimately mentions `_condensed` (it tells the model what to do
    // when it is present), so check the data message rather than the whole conversation.
    const userMessage = seen.messages.find((m) => m.role === 'user');
    assert.ok(!userMessage.content.includes('_condensed'),
      'the data sent for a fitting range must carry no condensing marker');
  });
});
