import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const mod = await import('../src/routes/usage/team-overview.js');
const { createTeamOverviewRouter } = mod;

function buildApp({ queryFn, user }) {
  const fakeAdmin = (req, res, next) => {
    req.user = user;
    if (!user || !['admin','super_admin'].includes(user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
  const router = createTeamOverviewRouter({ query: queryFn, adminAuth: fakeAdmin });
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

async function request(app, { method, path }) {
  return await new Promise((resolve, reject) => {
    const req = { method, url: path, path, headers: {}, body: {} };
    const res = {
      statusCode: 200, _headers: {},
      setHeader(k,v){this._headers[k]=v;}, getHeader(k){return this._headers[k];},
      status(c){this.statusCode=c;return this;},
      json(p){resolve({status:this.statusCode,body:p});},
      send(p){resolve({status:this.statusCode,body:p});},
      end(){resolve({status:this.statusCode,body:null});}
    };
    try { app.handle(req, res, e => e ? reject(e) : resolve({ status: res.statusCode })); }
    catch (e) { reject(e); }
  });
}

describe('GET /:user_id/sessions', () => {
  it('rejects non-admin', async () => {
    const app = buildApp({ queryFn: async () => ({ rows: [] }), user: { id: 2, role: 'normal' } });
    const r = await request(app, { method: 'GET', path: '/1/sessions' });
    assert.equal(r.status, 403);
  });

  it('returns session rows shape', async () => {
    const fakeRows = [{
      id: 248, created_at: '2026-04-28T01:00:00Z',
      tool: 'claude-code', model: 'claude-opus-4-7', machine: 'Vincent.local',
      summary: 'OwnMind 連發版',
      details: { project: 'ownmind', duration_turns: 60,
                 rules_complied: ['IR-003'], rules_skipped: [] },
      machine_os: 'darwin', machine_scanner_version: '0.4.1'
    }];
    const queryFn = async () => ({ rows: fakeRows });
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    const r = await request(app, { method: 'GET', path: '/1/sessions' });
    assert.equal(r.status, 200);
    assert.equal(r.body.user_id, 1);
    assert.equal(r.body.sessions.length, 1);
    const s = r.body.sessions[0];
    assert.equal(s.id, 248);
    assert.equal(s.tool, 'claude-code');
    assert.equal(s.machine, 'Vincent.local');
    assert.deepEqual(s.machine_meta, { os: 'darwin', scanner_version: '0.4.1' });
    assert.equal(s.project, 'ownmind');
    assert.equal(s.duration_turns, 60);
    assert.equal(s.rule_compliance.complied, 1);
    assert.equal(s.rule_compliance.triggered, 1);
    assert.equal(s.rule_compliance.rate, 1);
  });

  it('machine_meta is null when heartbeat fallback yields nothing', async () => {
    const queryFn = async () => ({ rows: [{
      id: 1, created_at: '2026-04-28T01:00:00Z',
      tool: 'cursor', model: 'unknown', machine: 'mystery',
      summary: '', details: null, machine_os: null, machine_scanner_version: null
    }]});
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    const r = await request(app, { method: 'GET', path: '/1/sessions' });
    assert.equal(r.body.sessions[0].machine_meta, null);
  });

  it('rejects non-numeric user_id with 400', async () => {
    const app = buildApp({ queryFn: async () => ({ rows: [] }), user: { id: 1, role: 'admin' } });
    const r = await request(app, { method: 'GET', path: '/abc/sessions' });
    assert.equal(r.status, 400);
  });

  it('caps limit at 500', async () => {
    let captured;
    const queryFn = async (_sql, params) => { captured = params; return { rows: [] }; };
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    await request(app, { method: 'GET', path: '/1/sessions?limit=9999' });
    assert.equal(captured[captured.length - 1], 500);
  });

  it('treats limit=0 as default 100', async () => {
    let captured;
    const queryFn = async (_sql, params) => { captured = params; return { rows: [] }; };
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    await request(app, { method: 'GET', path: '/1/sessions?limit=0' });
    assert.equal(captured[captured.length - 1], 100);
  });

  it('treats negative limit as default 100', async () => {
    let captured;
    const queryFn = async (_sql, params) => { captured = params; return { rows: [] }; };
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    await request(app, { method: 'GET', path: '/1/sessions?limit=-5' });
    assert.equal(captured[captured.length - 1], 100);
  });

  it('rejects invalid from/to with 400', async () => {
    const queryFn = async () => ({ rows: [] });
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    const r = await request(app, { method: 'GET', path: '/1/sessions?from=garbage' });
    assert.equal(r.status, 400);
  });
});
