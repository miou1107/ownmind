// v1.31.3 — tasks the AI picks up.
//
// A card is a dispatch note for one session: small by construction, claimed exclusively,
// finished by its holder, reviewed only by a person. These prove the normaliser, the status
// machine, the visibility rule and the claim expiry against a fake query.
//
// See openspec/changes/v1.31.3-tasks-the-ai-picks-up/spec.md.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {
  normalizeTaskCreate, normalizeTaskDone, normalizeLinks, claimNote,
  MAX_BODY_LENGTH, MAX_LINKS, CLAIM_TTL_HOURS,
} from '../shared/task-body.js';
import { createTasksRouter, expireStaleClaims } from '../src/routes/tasks.js';
import { renderSessionContext } from '../hooks/lib/render-session-context.js';
import { fetchProjectTasks } from '../hooks/lib/fetch-project-tasks.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');

describe('normalizeTaskCreate — small by construction', () => {
  it('keeps a well-formed card and defaults the flags', () => {
    const n = normalizeTaskCreate({ project: ' om ', title: ' fix it ', body: 'x', links: { Issue: 'https://g/1' } });
    assert.equal(n.ok, true);
    assert.deepEqual(n.task, { project: 'om', title: 'fix it', body: 'x', links: { issue: 'https://g/1' }, auto: false, is_private: false });
  });

  it('refuses a missing project or title, and a body past the cap, with a reason', () => {
    assert.equal(normalizeTaskCreate({ title: 't' }).ok, false);
    assert.equal(normalizeTaskCreate({ project: 'p' }).ok, false);
    const big = normalizeTaskCreate({ project: 'p', title: 't', body: 'x'.repeat(MAX_BODY_LENGTH + 1) });
    assert.equal(big.ok, false);
    assert.match(big.error, /split it/);
  });

  it('accepts `private` and `auto` only as true', () => {
    assert.equal(normalizeTaskCreate({ project: 'p', title: 't', private: 'yes', auto: 1 }).task.is_private, false);
    assert.equal(normalizeTaskCreate({ project: 'p', title: 't', private: true, auto: true }).task.auto, true);
  });
});

describe('normalizeLinks and normalizeTaskDone', () => {
  it('lowercases keys, drops blanks, caps the count', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_LINKS + 3 }, (_, i) => [`k${i}`, `v${i}`]));
    assert.equal(Object.keys(normalizeLinks(many)).length, MAX_LINKS);
    assert.deepEqual(normalizeLinks({ ' MR ': ' https://x ', empty: '', 3: 'n' }), { mr: 'https://x', 3: 'n' });
    assert.deepEqual(normalizeLinks(['a']), {});
  });

  it('done needs a result', () => {
    assert.equal(normalizeTaskDone({}).ok, false);
    assert.deepEqual(normalizeTaskDone({ result: ' done ', links: { mr: 'u' } }), { ok: true, result: 'done', links: { mr: 'u' } });
  });

  it('claimNote names the holder and the reason', () => {
    assert.match(claimNote('dropped', { name: 'Vin', reason: 'busy', at: new Date(0) }), /\[dropped 1970-01-01T00:00:00.000Z by Vin\] busy/);
    assert.match(claimNote('expired', { name: 'Vin', at: new Date(0) }), new RegExp(`${CLAIM_TTL_HOURS} hours`));
  });
});

// ── the router ──────────────────────────────────────────────────────────────────────────

function authAs(user) { return (req, res, next) => { req.user = user; next(); }; }
const VIN = { id: 7, name: 'Vin', role: 'user' };
const ERIC = { id: 2, name: 'Eric', role: 'admin' };

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

function buildApp(query, user = VIN) {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createTasksRouter({ query, auth: authAs(user), logger: { error() {} } }));
  return app;
}

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, method, path,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
      (r) => {
        let data = '';
        r.on('data', (c) => { data += c; });
        r.on('end', () => { server.close(); try { resolve({ status: r.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: r.statusCode, body: data }); } });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const OPEN = { id: 12, user_id: 7, project: 'om', title: 'T', body: '', status: 'open', is_private: false, claimed_by: null, holder_name: null };

describe('POST /api/tasks', () => {
  it('creates an open card owned by the caller', async () => {
    const q = scriptedQuery([[{ id: 12, status: 'open' }]]);
    const r = await request(buildApp(q), 'POST', '/api/tasks', { project: 'om', title: 'T', body: 'b', links: { issue: 'u' } });
    assert.equal(r.status, 201);
    assert.deepEqual(q.calls[0].values, [7, 'om', 'T', 'b', { issue: 'u' }, false, false]);
  });

  it('refuses a bad card before the database', async () => {
    const q = scriptedQuery([]);
    const r = await request(buildApp(q), 'POST', '/api/tasks', { project: 'om' });
    assert.equal(r.status, 400);
    assert.equal(q.calls.length, 0);
  });
});

describe('GET /api/tasks', () => {
  it('by project: open and claimed cards the caller may see', async () => {
    const q = scriptedQuery([[OPEN]]);
    const r = await request(buildApp(q), 'GET', '/api/tasks?project=om');
    assert.equal(r.status, 200);
    assert.match(q.calls[0].text, /t\.is_private = FALSE OR t\.user_id = \$1 OR t\.claimed_by = \$1/);
    assert.match(q.calls[0].text, /t\.status IN \('open', 'claimed'\)/);
    assert.match(q.calls[0].text, /\(t\.claimed_by = \$1\) AS held_by_me/);
    assert.deepEqual(q.calls[0].values, [7, 'om']);
  });

  it('mine: owned or held, not closed', async () => {
    const q = scriptedQuery([[]]);
    await request(buildApp(q), 'GET', '/api/tasks?mine=true');
    assert.match(q.calls[0].text, /t\.user_id = \$1 OR t\.claimed_by = \$1/);
    assert.match(q.calls[0].text, /NOT IN \('reviewed', 'dropped'\)/);
  });

  it('all: admin only, never private, and hands the database only the parameters it uses', async () => {
    const q = scriptedQuery([[], []]);
    const denied = await request(buildApp(q, VIN), 'GET', '/api/tasks?all=true');
    assert.equal(denied.status, 403);
    assert.equal(q.calls.length, 0);
    const ok = await request(buildApp(q, ERIC), 'GET', '/api/tasks?all=true&status=done');
    assert.equal(ok.status, 200);
    assert.match(q.calls[0].text, /t\.is_private = FALSE/);
    // Postgres refuses a parameter the statement never references; the all branch does not
    // filter on the caller, so the caller's id must not be sent.
    assert.deepEqual(q.calls[0].values, ['done']);
    await request(buildApp(q, ERIC), 'GET', '/api/tasks?all=true');
    assert.deepEqual(q.calls[1].values, []);
  });

  it('a list never carries the body; the console asks for it with full=true', async () => {
    const q = scriptedQuery([[], []]);
    await request(buildApp(q), 'GET', '/api/tasks?project=om');
    assert.ok(!/t\.body/.test(q.calls[0].text), 'fifty bodies of 4000 characters do not belong in the AI context');
    await request(buildApp(q), 'GET', '/api/tasks?project=om&full=true');
    assert.match(q.calls[1].text, /t\.body/);
  });

  it('needs one of the three selectors', async () => {
    const r = await request(buildApp(scriptedQuery([])), 'GET', '/api/tasks');
    assert.equal(r.status, 400);
  });
});

describe('PUT /api/tasks/:id/claim', () => {
  it('takes an open card in one statement, recording tool and session', async () => {
    const q = scriptedQuery([[{ id: 12, status: 'claimed', claimed_by: 7 }]]);
    const r = await request(buildApp(q), 'PUT', '/api/tasks/12/claim', { tool: 'claude-code', session_id: 's1' });
    assert.equal(r.status, 200);
    assert.match(q.calls[0].text, /status = 'open' OR \(status = 'claimed' AND claimed_by = \$2\)/);
    assert.deepEqual(q.calls[0].values, ['12', 7, 'claude-code', 's1']);
  });

  it('answers 409 naming the holder when someone else has it', async () => {
    const q = scriptedQuery([[], [{ ...OPEN, status: 'claimed', claimed_by: 2, holder_name: 'Eric', claimed_at: 'x' }]]);
    const r = await request(buildApp(q), 'PUT', '/api/tasks/12/claim', {});
    assert.equal(r.status, 409);
    assert.equal(r.body.claimed_by, 'Eric');
    // The MCP relays `error` and nothing beside it, so the name has to be in the sentence.
    assert.match(r.body.error, /claimed by Eric/);
  });

  it('answers 404 for a private card of someone else, and for a bad id', async () => {
    const q = scriptedQuery([[], []]);
    assert.equal((await request(buildApp(q), 'PUT', '/api/tasks/12/claim', {})).status, 404);
    assert.equal((await request(buildApp(scriptedQuery([])), 'PUT', '/api/tasks/x/claim', {})).status, 404);
  });
});

describe('PUT /api/tasks/:id/done and /drop', () => {
  it('done: only the holder, only while claimed; merges links', async () => {
    const q = scriptedQuery([[{ id: 12, status: 'done' }]]);
    const r = await request(buildApp(q), 'PUT', '/api/tasks/12/done', { result: 'did it', links: { mr: 'u' } });
    assert.equal(r.status, 200);
    assert.match(q.calls[0].text, /status = 'claimed' AND claimed_by = \$2/);
    assert.match(q.calls[0].text, /links = links \|\| \$4::jsonb/);
    assert.deepEqual(q.calls[0].values, ['12', 7, 'did it', '{"mr":"u"}']);
  });

  it('done: 403 for a card held by someone else, 400 without a result', async () => {
    const q = scriptedQuery([[], [{ ...OPEN, status: 'claimed', claimed_by: 2, holder_name: 'Eric' }]]);
    const r = await request(buildApp(q), 'PUT', '/api/tasks/12/done', { result: 'x' });
    assert.equal(r.status, 403);
    assert.equal((await request(buildApp(scriptedQuery([])), 'PUT', '/api/tasks/12/done', {})).status, 400);
  });

  it('drop: hands the card back with a note naming who and why', async () => {
    const q = scriptedQuery([[{ id: 12, status: 'open' }]]);
    const r = await request(buildApp(q), 'PUT', '/api/tasks/12/drop', { reason: 'out of time' });
    assert.equal(r.status, 200);
    assert.match(q.calls[0].text, /status = 'open', body = body \|\| \$3/);
    assert.match(q.calls[0].values[2], /by Vin\] out of time/);
  });
});

describe('PUT /api/tasks/:id/review', () => {
  it('owner closes a done card', async () => {
    const q = scriptedQuery([[{ ...OPEN, status: 'done' }], [{ id: 12, status: 'reviewed' }]]);
    const r = await request(buildApp(q), 'PUT', '/api/tasks/12/review', {});
    assert.equal(r.status, 200);
    assert.deepEqual(q.calls[1].values, ['12', 7]);
  });

  it('a non-owner member may not; an admin may; a card not done is 409', async () => {
    const other = { ...OPEN, user_id: 99, status: 'done' };
    assert.equal((await request(buildApp(scriptedQuery([[other]]), VIN), 'PUT', '/api/tasks/12/review', {})).status, 403);
    assert.equal((await request(buildApp(scriptedQuery([[other], [{ id: 12 }]]), ERIC), 'PUT', '/api/tasks/12/review', {})).status, 200);
    assert.equal((await request(buildApp(scriptedQuery([[OPEN]]), VIN), 'PUT', '/api/tasks/12/review', {})).status, 409);
  });
});

describe('the MCP side — five tools, no review tool, the project on init', () => {
  const src = readFileSync(join(repoRoot, 'mcp', 'index.js'), 'utf8');

  it('declares create, list, claim, done and drop — and nothing that reviews', () => {
    for (const name of ['ownmind_task_create', 'ownmind_task_list', 'ownmind_task_claim', 'ownmind_task_done', 'ownmind_task_drop']) {
      assert.ok(src.includes(`name: "${name}"`), `${name} is declared`);
      assert.ok(src.includes(`case "${name}":`), `${name} is handled`);
    }
    assert.ok(!/ownmind_task_review/.test(src), 'the AI never closes its own work');
  });

  it('a claim carries this session and tool, so the card knows which conversation did it', () => {
    const handler = src.slice(src.indexOf('case "ownmind_task_claim"'), src.indexOf('case "ownmind_task_done"'));
    assert.match(handler, /tool: CLIENT_TOOL/);
    assert.match(handler, /session_id: sessionStartTime/);
  });

  it('init tells the server which project it is in, when it knows', () => {
    assert.match(src, /\/api\/memory\/init\?client_version=\$\{CLIENT_VERSION\}&compact=true\$\{AUTO_PROJECT \? `&project=/);
  });
});

describe('renderSessionContext — the Task cards block', () => {
  const base = { server_version: '1.31.2', profile: null, iron_rules_digest: null, principles: [] };

  it('lists the cards with who holds them and how to take one', () => {
    const out = renderSessionContext({ ...base, tasks: { project: 'om', cards: [
      { id: 12, title: 'fix login', status: 'claimed', holder: 'you' },
      { id: 15, title: 'coupon', status: 'claimed', holder: 'Amiee' },
      { id: 16, title: 'csv', status: 'open', holder: null },
    ] } });
    assert.match(out, /## Task cards \(om\)/);
    assert.match(out, /- #12 — claimed by you — fix login/);
    assert.match(out, /- #15 — claimed by Amiee — coupon/);
    assert.match(out, /- #16 — csv/);
    assert.match(out, /ownmind_task_claim/);
    assert.match(out, /Never mark one reviewed/);
  });

  it('says nothing without cards', () => {
    for (const tasks of [null, undefined, { project: 'om', cards: [] }, {}]) {
      assert.ok(!/Task cards/.test(renderSessionContext({ ...base, tasks })));
    }
  });
});

describe('expireStaleClaims', () => {
  it('hands back claims older than the TTL and names them', async () => {
    const q = scriptedQuery([[{ id: 3 }, { id: 9 }]]);
    const r = await expireStaleClaims({ query: q, now: new Date(0) });
    assert.deepEqual(r, { expired: [3, 9] });
    assert.match(q.calls[0].text, /claimed_at < NOW\(\) - INTERVAL '1 hour' \* \$1/);
    assert.equal(q.calls[0].values[0], CLAIM_TTL_HOURS);
    assert.match(q.calls[0].values[1], /claim expired 1970/);
    // A holder whose account was deleted leaves claimed_by NULL; an inner join on users
    // would keep that card claimed forever.
    assert.ok(!/\sFROM users u\b/.test(q.calls[0].text), 'no inner join on users');
    assert.match(q.calls[0].text, /COALESCE\(\(SELECT name FROM users WHERE id = t\.claimed_by\), 'the holder'\)/);
  });
});

describe('every statement the router sends references exactly the parameters it is given', () => {
  // The defect this guards: a `values` list that starts with the caller's id for a branch
  // whose WHERE never mentions $1. Fake queries accept that; Postgres does not.
  function check(calls) {
    for (const { text, values } of calls) {
      const used = new Set((text.match(/\$(\d+)/g) || []).map((m) => Number(m.slice(1))));
      const max = used.size ? Math.max(...used) : 0;
      assert.equal(max, (values || []).length, `statement uses $1..$${max} but got ${(values || []).length} values:\n${text}`);
      for (let i = 1; i <= max; i += 1) assert.ok(used.has(i), `$${i} is never referenced:\n${text}`);
    }
  }

  it('holds for every list, claim, done, drop and review', async () => {
    const q = scriptedQuery(Array.from({ length: 20 }, () => [{ ...OPEN, status: 'done' }]));
    const app = buildApp(q, ERIC);
    await request(app, 'GET', '/api/tasks?project=om');
    await request(app, 'GET', '/api/tasks?mine=true');
    await request(app, 'GET', '/api/tasks?all=true');
    await request(app, 'GET', '/api/tasks?all=true&status=open');
    await request(app, 'POST', '/api/tasks', { project: 'om', title: 't' });
    await request(app, 'PUT', '/api/tasks/12/claim', { tool: 'x', session_id: 's' });
    await request(app, 'PUT', '/api/tasks/12/done', { result: 'r' });
    await request(app, 'PUT', '/api/tasks/12/drop', { reason: 'r' });
    await request(app, 'PUT', '/api/tasks/12/review', {});
    await expireStaleClaims({ query: q });
    check(q.calls);
  });
});

describe('fetchProjectTasks — the hook asks for cards outside the cache', () => {
  it('asks by project, puts this person first, cuts to five, says who holds what', async () => {
    const rows = [
      { id: 1, title: 'a', status: 'open', claimed_by: null, holder_name: null, held_by_me: false },
      { id: 2, title: 'b', status: 'claimed', claimed_by: 2, holder_name: 'Eric', held_by_me: false },
      { id: 3, title: 'c', status: 'claimed', claimed_by: 7, holder_name: 'Vin', held_by_me: true },
      { id: 4, title: 'd', status: 'open' }, { id: 5, title: 'e', status: 'open' }, { id: 6, title: 'f', status: 'open' },
    ];
    const urls = [];
    const fetchJson = async (url) => { urls.push(url); return { status: 200, body: JSON.stringify(rows) }; };
    const r = await fetchProjectTasks({ apiUrl: 'http://api/', apiKey: 'k', project: 'om', fetchJson });
    assert.equal(urls[0], 'http://api/api/tasks?project=om');
    assert.equal(r.project, 'om');
    assert.equal(r.cards.length, 5);
    assert.deepEqual(r.cards[0], { id: 3, title: 'c', status: 'claimed', holder: 'you' });
    assert.deepEqual(r.cards[2], { id: 2, title: 'b', status: 'claimed', holder: 'Eric' });
  });

  it('answers null without a project, without credentials, on a non-200 and on a thrown fetch', async () => {
    assert.equal(await fetchProjectTasks({ apiUrl: 'u', apiKey: 'k', project: null }), null);
    assert.equal(await fetchProjectTasks({ apiUrl: '', apiKey: 'k', project: 'p' }), null);
    assert.equal(await fetchProjectTasks({ apiUrl: 'u', apiKey: 'k', project: 'p', fetchJson: async () => ({ status: 404, body: '{}' }) }), null);
    assert.equal(await fetchProjectTasks({ apiUrl: 'u', apiKey: 'k', project: 'p', fetchJson: async () => { throw new Error('x'); } }), null);
  });
});
