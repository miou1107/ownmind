// v1.31.2 — collision warning.
//
// Before every file edit the hook tells the server which directory of which project it is
// in, and learns who else was there in the last two hours. One line into the AI's context
// when there is somebody; nothing otherwise; the edit is never blocked. The server never
// receives a file name or an absolute path.
//
// See openspec/changes/v1.31.2-collision-warning/spec.md.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';
import os from 'node:os';
import {
  touchOf, isValidTouch, renderOverlapLine, mergeOverlapIntoEnvelope, REPORT_WINDOW_MS, MAX_DIR_LENGTH,
} from '../shared/touch-report.js';
import {
  readTouchState, writeTouchState, decideTouchReport, recordTouchReport, unprintedOthers, touchKey,
} from '../hooks/lib/touch-state.js';
import { touchReport, OPT_OUT_FILE } from '../hooks/ownmind-touch-report.js';
import { createActivityTouchRouter } from '../src/routes/activity-touch.js';
import { runTouchCleanup } from '../src/jobs/touch-cleanup.js';

const sep = path.sep;
const proj = path.resolve(sep === '\\' ? 'C:\\work\\idaytour' : '/work/idaytour');
const under = (...parts) => path.join(proj, ...parts);

describe('touchOf — the project name and a relative directory, nothing else', () => {
  it('maps a file under the project to its directory', () => {
    assert.deepEqual(touchOf(under('src', 'order', 'cart.js'), proj), { project: 'idaytour', dir: 'src/order' });
  });

  it('uses "." for the project root', () => {
    assert.deepEqual(touchOf(under('package.json'), proj), { project: 'idaytour', dir: '.' });
  });

  it('never carries the file name or any absolute segment', () => {
    const t = touchOf(under('src', 'payroll', 'payroll-export.js'), proj);
    assert.ok(!JSON.stringify(t).includes('payroll-export'));
    assert.ok(!JSON.stringify(t).includes('work'));
  });

  it('answers null outside the project, at the root, and on rubbish', () => {
    assert.equal(touchOf(path.resolve(sep === '\\' ? 'C:\\elsewhere\\a.js' : '/elsewhere/a.js'), proj), null);
    assert.equal(touchOf(under('a.js'), path.parse(proj).root), null);
    for (const bad of [['', proj], [under('a.js'), ''], [null, proj], [under('a.js'), undefined]]) {
      assert.equal(touchOf(...bad), null);
    }
  });

  it('keeps the tail of a very deep directory', () => {
    const deep = Array.from({ length: 60 }, (_, i) => `d${i}`);
    const t = touchOf(under(...deep, 'f.js'), proj);
    assert.ok(t.dir.length <= MAX_DIR_LENGTH);
    assert.ok(t.dir.endsWith('d59'));
  });
});

describe('isValidTouch — the server refuses what the client would never send', () => {
  it('accepts a project and a relative dir', () => {
    assert.equal(isValidTouch({ project: 'om', dir: 'src/routes' }), true);
    assert.equal(isValidTouch({ project: 'om', dir: '.' }), true);
  });

  it('refuses absolute paths, drive letters, backslashes, parent segments and bad names', () => {
    for (const bad of [
      { project: 'om', dir: '/etc' }, { project: 'om', dir: 'C:/x' }, { project: 'om', dir: 'a\\b' },
      { project: 'om', dir: 'a/../b' }, { project: 'om', dir: '' }, { project: 'a/b', dir: '.' },
      { project: '', dir: '.' }, { dir: '.' }, null, 'x',
    ]) {
      assert.equal(isValidTouch(bad), false, JSON.stringify(bad));
    }
  });
});

describe('renderOverlapLine — one line, model-facing, asks the AI to tell the person once', () => {
  it('names everyone with minutes, and the place', () => {
    const line = renderOverlapLine([{ name: 'Amiee', minutes_ago: 12 }, { name: 'Eric', minutes_ago: 90.4 }], { project: 'idaytour', dir: 'src/order' }, '1.31.1');
    assert.match(line, /^\[OwnMind v1\.31\.1\]/);
    assert.match(line, /Amiee \(12 min ago\)/);
    assert.match(line, /Eric \(90 min ago\)/);
    assert.match(line, /src\/order\/ in idaytour/);
    assert.match(line, /Tell the user once/);
  });

  it('says "the root of" for the project root and nothing for nobody', () => {
    assert.match(renderOverlapLine([{ name: 'A', minutes_ago: 1 }], { project: 'om', dir: '.' }, '1'), /the root of om/);
    assert.equal(renderOverlapLine([], { project: 'om', dir: '.' }, '1'), '');
  });
});

describe('touch state — one request per directory per ten minutes, each colleague mentioned once', () => {
  it('asks the first time, reuses inside the window, asks again after it', () => {
    const state = { sessions: {} };
    const key = touchKey({ project: 'om', dir: 'src' });
    assert.equal(decideTouchReport(state, 's1', key, 1000).report, true);
    recordTouchReport(state, 's1', key, [{ name: 'A', minutes_ago: 3 }], 1000);
    const inside = decideTouchReport(state, 's1', key, 1000 + REPORT_WINDOW_MS - 1);
    assert.equal(inside.report, false);
    assert.deepEqual(inside.others, [{ name: 'A', minutes_ago: 3 }]);
    assert.equal(decideTouchReport(state, 's1', key, 1000 + REPORT_WINDOW_MS).report, true);
    assert.equal(decideTouchReport(state, 's2', key, 1000).report, true, 'another session has its own window');
  });

  it('mentions a colleague once per session and directory', () => {
    const state = { sessions: {} };
    const key = 'om/src';
    assert.deepEqual(unprintedOthers(state, 's1', key, [{ name: 'A' }, { name: 'B' }]).map((o) => o.name), ['A', 'B']);
    assert.deepEqual(unprintedOthers(state, 's1', key, [{ name: 'A' }, { name: 'C' }]).map((o) => o.name), ['C']);
    assert.deepEqual(unprintedOthers(state, 's1', 'om/other', [{ name: 'A' }]).map((o) => o.name), ['A']);
  });

  it('round-trips through the file and drops sessions older than a day', () => {
    const home = tempDir('ownmind-touch-');
    try {
      const file = path.join(home, '.ownmind', 'state', 'touches.json');
      const state = { sessions: {} };
      recordTouchReport(state, 'old', 'om/a', [], 0);
      recordTouchReport(state, 'live', 'om/b', [], 10 * 60 * 60 * 1000);
      assert.equal(writeTouchState(file, state, 25 * 60 * 60 * 1000), true);
      const back = readTouchState(file);
      assert.deepEqual(Object.keys(back.sessions), ['live']);
      assert.deepEqual(readTouchState(path.join(home, 'missing.json')), { sessions: {} });
      fs.writeFileSync(file, '{not json');
      assert.deepEqual(readTouchState(file), { sessions: {} });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('touchReport — the hook half, with the network injected', () => {
  function setup() {
    const home = tempDir('ownmind-touch-hook-');
    const calls = [];
    const post = async (url, key, body) => {
      calls.push({ url, key, body });
      return { status: 200, body: JSON.stringify({ others: [{ name: 'Amiee', minutes_ago: 12 }] }) };
    };
    const base = {
      apiKey: 'k', apiUrl: 'http://api.test', sessionId: 's1', version: '1.31.1', home, post,
      filePath: under('src', 'order', 'cart.js'), projectDir: proj, now: 1_000_000,
    };
    return { home, calls, post, base, done: () => fs.rmSync(home, { recursive: true, force: true }) };
  }

  it('posts the directory, never the file, and prints the colleague once', async () => {
    const { calls, base, done } = setup();
    try {
      const line = await touchReport(base);
      assert.match(line, /Amiee \(12 min ago\)/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'http://api.test/api/activity/touch');
      assert.deepEqual(calls[0].body, { project: 'idaytour', dir: 'src/order', session_id: 's1' });
      assert.ok(!JSON.stringify(calls[0].body).includes('cart.js'));

      const again = await touchReport({ ...base, now: base.now + 1000, filePath: under('src', 'order', 'total.js') });
      assert.equal(again, '', 'same colleague, same directory, same session: not repeated');
      assert.equal(calls.length, 1, 'inside the window, no second request');
    } finally { done(); }
  });

  it('is silent with no key, no session, outside the project, or opted out — and posts nothing', async () => {
    const { calls, base, home, done } = setup();
    try {
      assert.equal(await touchReport({ ...base, apiKey: '' }), '');
      assert.equal(await touchReport({ ...base, sessionId: '' }), '');
      assert.equal(await touchReport({ ...base, filePath: path.resolve(sep === '\\' ? 'C:\\x\\y.js' : '/x/y.js') }), '');
      fs.mkdirSync(path.join(home, '.ownmind'), { recursive: true });
      fs.writeFileSync(path.join(home, '.ownmind', OPT_OUT_FILE), '');
      assert.equal(await touchReport(base), '');
      assert.equal(calls.length, 0);
    } finally { done(); }
  });

  it('fails open and writes a touch_report_failed event when the server does not answer 200', async () => {
    const { base, home, done } = setup();
    try {
      const line = await touchReport({ ...base, post: async () => ({ status: 404, body: 'nope' }) });
      assert.equal(line, '');
      // A second directory: the first failure opened the window for src/order, so the same
      // directory would (correctly) post nothing and log nothing.
      const line2 = await touchReport({ ...base, filePath: under('src', 'coupon', 'x.js'), post: async () => { throw new Error('timeout'); } });
      assert.equal(line2, '');
      const logs = fs.readdirSync(path.join(home, '.ownmind', 'logs'));
      const text = logs.map((f) => fs.readFileSync(path.join(home, '.ownmind', 'logs', f), 'utf8')).join('');
      const events = text.trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(events.map((e) => e.details.reason), ['http_404', 'timeout']);
      assert.ok(events.every((e) => e.event === 'touch_report_failed'));
    } finally { done(); }
  });
});

describe('touchOf — nothing under the home directory, ever', () => {
  const home = path.resolve(os.homedir());

  it('answers null when the project is the home directory or above it', () => {
    assert.equal(touchOf(path.join(home, 'Documents', 'tax', 'a.js'), home), null);
    const parent = path.dirname(home);
    if (parent !== home) assert.equal(touchOf(path.join(home, 'work', 'x', 'a.js'), parent), null);
  });

  it('still answers for a project inside the home directory', () => {
    const p = path.join(home, 'src', 'om');
    assert.deepEqual(touchOf(path.join(p, 'hooks', 'x.js'), p), { project: 'om', dir: 'hooks' });
  });
});

describe('mergeOverlapIntoEnvelope — one envelope for the AI', () => {
  const reminder = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'rules: 2' } });
  const deny = JSON.stringify({ decision: 'block', reason: 'no', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });

  it('appends to the reminder, stands alone without one, and leaves a deny untouched', () => {
    const merged = JSON.parse(mergeOverlapIntoEnvelope(reminder, 'Amiee is here'));
    assert.equal(merged.hookSpecificOutput.additionalContext, 'rules: 2\nAmiee is here');
    const alone = JSON.parse(mergeOverlapIntoEnvelope('', 'Amiee is here'));
    assert.equal(alone.hookSpecificOutput.additionalContext, 'Amiee is here');
    assert.equal(mergeOverlapIntoEnvelope(deny, 'Amiee is here'), deny);
    assert.equal(mergeOverlapIntoEnvelope(reminder, ''), reminder);
    assert.equal(mergeOverlapIntoEnvelope('', ''), '');
    assert.equal(mergeOverlapIntoEnvelope('not json', 'x'), 'not json');
  });
});

describe('touchReport — a failure opens the window too', () => {
  it('does not post again inside ten minutes after a failed call', async () => {
    const home = tempDir('ownmind-touch-backoff-');
    try {
      let calls = 0;
      const post = async () => { calls += 1; throw new Error('timeout'); };
      const base = {
        apiKey: 'k', apiUrl: 'http://api.test', sessionId: 's1', version: '1', home, post,
        filePath: under('src', 'a.js'), projectDir: proj, now: 5_000_000,
      };
      assert.equal(await touchReport(base), '');
      assert.equal(await touchReport({ ...base, now: base.now + 60_000, filePath: under('src', 'b.js') }), '');
      assert.equal(calls, 1, 'the second edit inside the window must not pay the timeout again');
      await touchReport({ ...base, now: base.now + REPORT_WINDOW_MS + 1 });
      assert.equal(calls, 2, 'after the window it asks again');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── the server half, against a fake query ──────────────────────────────────────────────

function fakeAuth(req, res, next) { req.user = { id: 7, name: 'Vin', role: 'user' }; next(); }
function fakeAdmin(req, res, next) { req.user = { id: 1, role: 'admin' }; next(); }

function scriptedQuery(answers) {
  const calls = [];
  const fn = async (text, values) => {
    calls.push({ text, values });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next && next.rowCount !== undefined ? next : { rows: next || [] };
  };
  fn.calls = calls;
  return fn;
}

function buildApp(query) {
  const app = express();
  app.use(express.json());
  app.use('/api/activity/touch', createActivityTouchRouter({ query, auth: fakeAuth, adminAuth: fakeAdmin, logger: { error() {} } }));
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

describe('POST /api/activity/touch', () => {
  it('upserts my touch and answers the others in the window', async () => {
    const q = scriptedQuery([[], [{ name: 'Amiee', minutes_ago: '12' }]]);
    const r = await request(buildApp(q), 'POST', '/api/activity/touch', { project: 'idaytour', dir: 'src/order', session_id: 's1' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { others: [{ name: 'Amiee', minutes_ago: 12 }] });
    const [upsert, select] = q.calls;
    assert.match(upsert.text, /ON CONFLICT \(user_id, project, dir, session_id\)/);
    assert.deepEqual(upsert.values, [7, 'idaytour', 'src/order', 's1']);
    assert.match(select.text, /t\.user_id <> \$3/, 'a person does not collide with themself');
    assert.match(select.text, /INTERVAL '1 minute' \* \$4/);
    assert.deepEqual(select.values, ['idaytour', 'src/order', 7, 120]);
  });

  it('refuses a touch that is not a project-relative directory, before touching the database', async () => {
    const q = scriptedQuery([]);
    for (const bad of [{ project: 'om', dir: '/etc' }, { project: 'om', dir: 'a/../b' }, { project: 'om' }, {}]) {
      const r = await request(buildApp(q), 'POST', '/api/activity/touch', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(q.calls.length, 0);
  });

  it('says 500 when the table is missing', async () => {
    const q = scriptedQuery([new Error('relation "edit_touches" does not exist')]);
    const r = await request(buildApp(q), 'POST', '/api/activity/touch', { project: 'om', dir: '.' });
    assert.equal(r.status, 500);
  });
});

describe('GET /api/activity/touch/overlaps', () => {
  it('answers the pairs of the last day', async () => {
    const row = { project: 'idaytour', dir: 'src/order', first_name: 'Amiee', second_name: 'Vin', last_seen: '2026-10-03T10:00:00Z' };
    const q = scriptedQuery([[row]]);
    const r = await request(buildApp(q), 'GET', '/api/activity/touch/overlaps');
    assert.equal(r.status, 200);
    assert.equal(r.body.window_hours, 24);
    assert.deepEqual(r.body.overlaps, [row]);
    assert.match(q.calls[0].text, /a\.user_id < b\.user_id/, 'each pair once');
  });
});

describe('runTouchCleanup', () => {
  it('deletes rows older than a day and reports the count', async () => {
    const q = scriptedQuery([{ rows: [], rowCount: 5 }]);
    const r = await runTouchCleanup({ query: q });
    assert.deepEqual(r, { deleted: 5 });
    assert.match(q.calls[0].text, /DELETE FROM edit_touches/);
    assert.deepEqual(q.calls[0].values, [24]);
  });
});
