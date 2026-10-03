// v1.31.0 — lessons at close.
//
// A closed session leaves a summary and loses the part worth keeping: where it got stuck,
// what unstuck it, what to do differently. `ownmind_log_session` now takes `lessons`, the
// server keeps each one as a row that waits for the person, and the console promotes or
// dismisses it. Nothing here writes a memory without a click.
//
// See openspec/changes/v1.31.0-lessons-at-close/spec.md.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeLessons, lessonToMemory, MAX_LESSONS_PER_SESSION, MAX_LESSON_FIELD_LENGTH,
} from '../shared/session-lessons.js';
import { buildSessionLogBody } from '../mcp/lib/session-log-body.js';
import { createSessionLessonsRouter } from '../src/routes/session-lessons.js';
import { storeSessionLessons } from '../src/lib/session-lessons-store.js';
import { renderSessionContext } from '../hooks/lib/render-session-context.js';
import { fetchSyncTokenInfo, overlayLiveFields, runConditionalSync, writeCache } from '../hooks/lib/conditional-sync.js';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');

describe('normalizeLessons — one shape on both ends', () => {
  it('keeps objects with a stuck, accepts bare strings, drops the rest and counts them', () => {
    const { lessons, dropped } = normalizeLessons([
      'cache was stale',
      { stuck: 'x', fix: ' y ' },
      { fix: 'no stuck' },
      42,
      null,
      { stuck: '   ' },
    ]);
    assert.deepEqual(lessons, [{ stuck: 'cache was stale' }, { stuck: 'x', fix: 'y' }]);
    assert.equal(dropped, 4);
  });

  it('caps the list and the fields', () => {
    const many = Array.from({ length: MAX_LESSONS_PER_SESSION + 5 }, (_, i) => ({ stuck: `s${i}` }));
    const r = normalizeLessons(many);
    assert.equal(r.lessons.length, MAX_LESSONS_PER_SESSION);
    assert.equal(r.dropped, 5);
    const long = normalizeLessons([{ stuck: 'a'.repeat(MAX_LESSON_FIELD_LENGTH + 10) }]);
    assert.equal(long.lessons[0].stuck.length, MAX_LESSON_FIELD_LENGTH);
  });

  it('answers empty for anything that is not a list', () => {
    for (const bad of [undefined, null, 'text', 3, {}]) {
      assert.deepEqual(normalizeLessons(bad), { lessons: [], dropped: 0 });
    }
  });

  it('never carries an empty fix or next_time', () => {
    const { lessons } = normalizeLessons([{ stuck: 's', fix: '', next_time: '  ' }]);
    assert.deepEqual(lessons, [{ stuck: 's' }]);
  });
});

describe('lessonToMemory — the memory a kept lesson becomes', () => {
  it('keeps the three answers apart and tags the project', () => {
    const m = lessonToMemory({ stuck: 'S', fix: 'F', next_time: 'N', project: 'om' });
    assert.equal(m.title, '[om] S');
    assert.equal(m.content, 'Stuck: S\nFix: F\nNext time: N');
    assert.deepEqual(m.tags, ['lesson', 'project:om']);
  });

  it('shortens a long stuck for the title and leaves the body whole', () => {
    const stuck = 'x'.repeat(300);
    const m = lessonToMemory({ stuck });
    assert.ok(m.title.length <= 120);
    assert.ok(m.content.includes(stuck));
    assert.deepEqual(m.tags, ['lesson']);
  });
});

describe('buildSessionLogBody — lessons travel only when there are any', () => {
  const clientTool = 'claude-code';

  it('carries normalised lessons', () => {
    const body = buildSessionLogBody({ summary: 's', lessons: [{ stuck: 'a', fix: ' b ' }, 'c'] }, { clientTool });
    assert.deepEqual(body.lessons, [{ stuck: 'a', fix: 'b' }, { stuck: 'c' }]);
  });

  it('leaves lessons absent when nothing usable was passed', () => {
    for (const empty of [undefined, [], [''], [{ fix: 'only' }], 'not a list']) {
      const body = buildSessionLogBody({ summary: 's', lessons: empty }, { clientTool });
      assert.ok(!('lessons' in body), `lessons=${JSON.stringify(empty)} must not reach the server`);
    }
  });

  it('changes nothing else about the body', () => {
    const body = buildSessionLogBody({ summary: 's', details: { project: 'p' } }, { clientTool });
    assert.deepEqual(body, { summary: 's', tool: 'claude-code', details: { project: 'p' } });
  });
});

describe('the tool schema', () => {
  // mcp/index.js starts a server on import, so it is read as text, as the other schema
  // tests do.
  const src = readFileSync(join(repoRoot, 'mcp', 'index.js'), 'utf8');
  const start = src.indexOf('name: "ownmind_log_session"');
  const end = src.indexOf('name: "ownmind_get_secret"', start);
  const block = src.slice(start, end);

  it('declares lessons as an optional array of { stuck, fix?, next_time? }', () => {
    assert.match(block, /lessons:\s*\{\s*type:\s*"array"/);
    assert.match(block, /stuck:\s*\{\s*type:\s*"string"/);
    assert.match(block, /required:\s*\["stuck"\]/);
    // Only summary is required at the top level: requiring lessons would discard the whole
    // session record to protect a list the AI may honestly have nothing to put in.
    assert.match(block, /required:\s*\["summary"\]/);
  });

  it('answers with a notice, not a refusal, when no lessons came', () => {
    const handler = src.slice(src.indexOf('case "ownmind_log_session"'), src.indexOf('case "ownmind_get_secret"'));
    assert.match(handler, /lessons_notice/);
    assert.ok(!/throw new Error\([^)]*lessons/.test(handler), 'the close must never be refused for missing lessons');
  });

  it('says so when an older server dropped the lessons it was sent', () => {
    // A pre-1.31 server ignores `lessons` and answers without `lessons_saved`. Silence there
    // would let the AI report lessons as kept.
    const handler = src.slice(src.indexOf('case "ownmind_log_session"'), src.indexOf('case "ownmind_get_secret"'));
    assert.match(handler, /data\.lessons_saved === undefined/);
    assert.match(handler, /older than v1\.31\.0/);
  });
});

describe('the app mounts /api/session/lessons before /api/session', () => {
  it('so the session router never shadows it', () => {
    const app = readFileSync(join(repoRoot, 'src', 'app.js'), 'utf8');
    const lessons = app.indexOf("app.use('/api/session/lessons'");
    const session = app.indexOf("app.use('/api/session', sessionRoutes)");
    assert.ok(lessons > 0 && session > 0, 'both mounts exist');
    assert.ok(lessons < session, 'lessons must be mounted first');
  });
});

describe('storeSessionLessons — the server keeps what it may, and counts the rest', () => {
  function scripted(answers) {
    const calls = [];
    const fn = async (text, values) => {
      calls.push({ text, values });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { rows: next || [] };
    };
    fn.calls = calls;
    return fn;
  }
  const quiet = { error() {}, warn() {} };

  it('inserts one row per lesson with the session and project, through the sanitizer', async () => {
    const q = scripted([[], []]);
    const r = await storeSessionLessons({
      query: q, logger: quiet, userId: 7, sessionLogId: 11, project: 'om',
      lessons: [{ stuck: 'a', fix: 'b' }, { stuck: 'c' }],
      sanitize: (s) => `<${s}>`,
    });
    assert.deepEqual(r, { saved: 2, rejected: 0 });
    assert.deepEqual(q.calls[0].values, [7, 11, 'om', '<a>', '<b>', null]);
    assert.deepEqual(q.calls[1].values, [7, 11, 'om', '<c>', null, null]);
  });

  it('refuses a lesson the memory write would refuse, and never sends it to the database', async () => {
    const q = scripted([[]]);
    const r = await storeSessionLessons({
      query: q, logger: quiet, userId: 7, sessionLogId: 11, project: null,
      lessons: [
        { stuck: 'fine' },
        { stuck: 'leaked', fix: ['OPENAI_API_KEY=sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP'].join('-') },
      ],
    });
    assert.deepEqual(r, { saved: 1, rejected: 1 });
    assert.equal(q.calls.length, 1);
    assert.ok(!JSON.stringify(q.calls).includes('sk-proj-'));
  });

  it('keeps a long project name inside the column', async () => {
    const q = scripted([[]]);
    await storeSessionLessons({ query: q, logger: quiet, userId: 7, sessionLogId: 1, project: 'p'.repeat(300), lessons: [{ stuck: 's' }] });
    assert.equal(q.calls[0].values[2].length, 255);
  });

  it('survives a database without the table: nothing saved, nothing thrown', async () => {
    const q = scripted([new Error('relation "session_lessons" does not exist'), new Error('again')]);
    const r = await storeSessionLessons({ query: q, logger: quiet, userId: 7, sessionLogId: 1, project: 'p', lessons: [{ stuck: 'a' }, { stuck: 'b' }] });
    assert.deepEqual(r, { saved: 0, rejected: 0 });
  });
});

describe('the waiting count is live, not cached', () => {
  it('fetchSyncTokenInfo keeps lessons_waiting beside the token, and only when it is a count', async () => {
    const fetchFn = async () => ({ ok: true, json: async () => ({ sync_token: 't1', lessons_waiting: 4 }) });
    assert.deepEqual(await fetchSyncTokenInfo('http://api', 'k', fetchFn), { sync_token: 't1', lessons_waiting: 4 });
    const noCount = async () => ({ ok: true, json: async () => ({ sync_token: 't1', lessons_waiting: null }) });
    assert.deepEqual(await fetchSyncTokenInfo('http://api', 'k', noCount), { sync_token: 't1' });
    assert.equal(await fetchSyncTokenInfo('http://api', 'k', async () => ({ ok: false })), null);
  });

  it('overlayLiveFields replaces the cached count and nothing else', () => {
    const data = { profile: { name: 'Vin' }, lessons_waiting: 0 };
    assert.deepEqual(overlayLiveFields(data, { sync_token: 't', lessons_waiting: 3 }), { profile: { name: 'Vin' }, lessons_waiting: 3 });
    assert.equal(overlayLiveFields(data, { sync_token: 't' }), data, 'no count from the server: the cache stands');
    assert.equal(overlayLiveFields(null, { lessons_waiting: 3 }), null);
  });

  it('a fresh cache is served with the count the server just gave', async () => {
    const home = tempDir('ownmind-lessons-cache-');
    try {
      const cachePath = path.join(home, 'memories.json');
      const account = { apiUrl: 'http://api', apiKey: 'k' };
      writeCache({ sync_token: 't1', data: { profile: null, lessons_waiting: 0 } }, cachePath, fs, account);
      const fetchFn = async (url) => {
        assert.match(url, /\/api\/memory\/sync-token$/, 'a fresh cache costs one light request, not an init');
        return { ok: true, json: async () => ({ sync_token: 't1', lessons_waiting: 2 }) };
      };
      const r = await runConditionalSync({ ...account, cachePath, fetchFn, now: Date.now() });
      assert.equal(r.source, 'cache_fresh');
      assert.equal(r.data.lessons_waiting, 2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── the router, against a fake query ──────────────────────────────────────────────────

function fakeAuth(req, res, next) { req.user = { id: 7, name: 'Vin', role: 'user' }; next(); }

function buildApp(query) {
  const app = express();
  app.use(express.json());
  app.use('/api/session/lessons', createSessionLessonsRouter({ query, auth: fakeAuth, logger: { error() {} } }));
  return app;
}

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, method, path,
          headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
        (r) => {
          let data = '';
          r.on('data', (c) => { data += c; });
          r.on('end', () => {
            server.close();
            try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
            catch { resolve({ status: r.statusCode, body: data }); }
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

/** A query double that records every call and answers from a script of row sets. */
function scriptedQuery(answers) {
  const calls = [];
  const fn = async (text, values) => {
    calls.push({ text, values });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { rows: next || [] };
  };
  fn.calls = calls;
  return fn;
}

const NEW_ROW = {
  id: 3, user_id: 7, session_log_id: 11, project: 'om', stuck: 'S', fix: 'F', next_time: 'N',
  status: 'new', memory_id: null, created_at: '2026-10-03T00:00:00Z', resolved_at: null,
};

describe('GET /api/session/lessons', () => {
  it('lists my new lessons by default, with no time window', async () => {
    const q = scriptedQuery([[NEW_ROW]]);
    const r = await request(buildApp(q), 'GET', '/api/session/lessons');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [NEW_ROW]);
    assert.match(q.calls[0].text, /user_id = \$1/);
    assert.match(q.calls[0].text, /status = \$2/);
    assert.ok(!/INTERVAL/.test(q.calls[0].text), 'a waiting lesson does not expire');
    assert.deepEqual(q.calls[0].values, [7, 'new']);
  });

  it('windows resolved lessons by days', async () => {
    const q = scriptedQuery([[]]);
    const r = await request(buildApp(q), 'GET', '/api/session/lessons?status=promoted&days=7');
    assert.equal(r.status, 200);
    assert.match(q.calls[0].text, /INTERVAL/);
    assert.deepEqual(q.calls[0].values, [7, 'promoted', 7]);
  });

  it('treats an unknown status as new', async () => {
    const q = scriptedQuery([[]]);
    await request(buildApp(q), 'GET', '/api/session/lessons?status=bogus');
    assert.deepEqual(q.calls[0].values, [7, 'new']);
  });

  it('says 500 Query failed when the table is not there', async () => {
    const q = scriptedQuery([new Error('relation "session_lessons" does not exist')]);
    const r = await request(buildApp(q), 'GET', '/api/session/lessons');
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'Query failed');
  });
});

describe('PUT /api/session/lessons/:id/promote', () => {
  it('writes one project memory and marks the lesson promoted', async () => {
    const memoryRow = { id: 99, type: 'project', title: '[om] S', content: 'Stuck: S\nFix: F\nNext time: N', tags: ['lesson', 'project:om'] };
    const q = scriptedQuery([[NEW_ROW], [memoryRow], [], [{ ...NEW_ROW, status: 'promoted', memory_id: 99 }]]);
    const r = await request(buildApp(q), 'PUT', '/api/session/lessons/3/promote', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.memory.id, 99);
    assert.equal(r.body.lesson.status, 'promoted');
    assert.equal(r.body.lesson.memory_id, 99);

    const [select, insert, history, update] = q.calls;
    // The console's history view starts from the 'create' row every other memory write
    // leaves; a promoted lesson leaves one too.
    assert.match(history.text, /INSERT INTO memory_history/);
    assert.deepEqual(history.values.slice(0, 2), [99, 'Stuck: S\nFix: F\nNext time: N']);
    assert.deepEqual(select.values, ['3', 7]);
    assert.match(insert.text, /INSERT INTO memories/);
    assert.match(insert.text, /'project'/);
    assert.equal(insert.values[0], 7);
    assert.equal(insert.values[1], '[om] S');
    assert.equal(insert.values[2], 'Stuck: S\nFix: F\nNext time: N');
    assert.deepEqual(insert.values[3], ['lesson', 'project:om']);
    assert.deepEqual(insert.values[4], { source: 'session_lesson', lesson_id: 3, session_log_id: 11 });
    assert.match(update.text, /status = 'promoted'/);
    assert.deepEqual(update.values, [99, 3, 7]);
  });

  it('refuses a lesson already resolved with 409 and writes nothing', async () => {
    const q = scriptedQuery([[{ ...NEW_ROW, status: 'dismissed' }]]);
    const r = await request(buildApp(q), 'PUT', '/api/session/lessons/3/promote', {});
    assert.equal(r.status, 409);
    assert.equal(r.body.status, 'dismissed');
    assert.equal(q.calls.length, 1);
  });

  it('answers 404 for a lesson that is not mine or an id that is not a number', async () => {
    const q = scriptedQuery([[]]);
    const r = await request(buildApp(q), 'PUT', '/api/session/lessons/3/promote', {});
    assert.equal(r.status, 404);
    const r2 = await request(buildApp(scriptedQuery([])), 'PUT', '/api/session/lessons/abc/promote', {});
    assert.equal(r2.status, 404);
  });

  it('refuses a lesson that quotes a secret, names the rule, and quotes nothing', async () => {
    const leaky = { ...NEW_ROW, fix: 'set ' + ['OPENAI_API_KEY=sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP'].join('-') };
    const q = scriptedQuery([[leaky]]);
    const r = await request(buildApp(q), 'PUT', '/api/session/lessons/3/promote', {});
    assert.equal(r.status, 400);
    assert.ok(r.body.rule, 'the rule that matched is named');
    assert.ok(!JSON.stringify(r.body).includes('sk-proj-'), 'no fragment of the secret leaves the server');
    assert.equal(q.calls.length, 1, 'nothing is written');
  });
});

describe('PUT /api/session/lessons/:id/dismiss', () => {
  it('marks a new lesson dismissed', async () => {
    const q = scriptedQuery([[{ ...NEW_ROW, status: 'dismissed' }]]);
    const r = await request(buildApp(q), 'PUT', '/api/session/lessons/3/dismiss', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'dismissed');
    assert.match(q.calls[0].text, /status = 'new'/);
    assert.deepEqual(q.calls[0].values, ['3', 7]);
  });

  it('answers 404 when the row is already resolved', async () => {
    const r = await request(buildApp(scriptedQuery([[]])), 'PUT', '/api/session/lessons/3/dismiss', {});
    assert.equal(r.status, 404);
  });
});

// ── the session-start context ────────────────────────────────────────────────────────

describe('renderSessionContext — the waiting line', () => {
  const base = { server_version: '1.31.0', profile: null, iron_rules_digest: null, principles: [] };

  it('names the count and the page when lessons wait', () => {
    const out = renderSessionContext({ ...base, lessons_waiting: 3 });
    assert.match(out, /## Lessons waiting: 3/);
    assert.match(out, /\/portal\/lessons/);
  });

  it('says nothing when none wait, or when the server could not count', () => {
    for (const n of [0, null, undefined, 'x']) {
      const out = renderSessionContext({ ...base, lessons_waiting: n });
      assert.ok(!/Lessons waiting/.test(out), `lessons_waiting=${n} must print nothing`);
    }
  });
});
