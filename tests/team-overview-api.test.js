import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../src/routes/usage/team-overview.js');
const { extractRuleCounts, aggregateCompliance, pickTopProject } = mod;

describe('extractRuleCounts', () => {
  it('returns zeros for null details', () => {
    assert.deepEqual(extractRuleCounts(null), { complied: 0, skipped: 0, triggered: 0 });
  });
  it('returns zeros for details without rule arrays', () => {
    assert.deepEqual(extractRuleCounts({ project: 'foo' }), { complied: 0, skipped: 0, triggered: 0 });
  });
  it('counts rules_complied and rules_skipped', () => {
    const d = { rules_complied: ['IR-003','IR-008'], rules_skipped: ['IR-009'] };
    assert.deepEqual(extractRuleCounts(d), { complied: 2, skipped: 1, triggered: 3 });
  });
  it('treats non-array rules fields as zero', () => {
    assert.deepEqual(
      extractRuleCounts({ rules_complied: 'IR-003', rules_skipped: null }),
      { complied: 0, skipped: 0, triggered: 0 }
    );
  });
});

describe('aggregateCompliance', () => {
  it('returns rate=null when no session triggers any rule', () => {
    const sessions = [{ details: { project: 'a' } }, { details: null }];
    const r = aggregateCompliance(sessions);
    assert.equal(r.triggered, 0);
    assert.equal(r.rate, null);
  });
  it('aggregates across sessions', () => {
    const sessions = [
      { details: { rules_complied: ['IR-003','IR-008'], rules_skipped: [] } },
      { details: { rules_complied: ['IR-009'], rules_skipped: ['IR-008'] } }
    ];
    const r = aggregateCompliance(sessions);
    assert.equal(r.complied, 3);
    assert.equal(r.triggered, 4);
    assert.equal(r.rate, 0.75);
  });
  it('returns zero complied and rate=null for empty sessions', () => {
    const r = aggregateCompliance([]);
    assert.equal(r.triggered, 0);
    assert.equal(r.rate, null);
    assert.equal(r.complied, 0);
  });
});

describe('pickTopProject', () => {
  it('returns null when no project in any session', () => {
    assert.equal(pickTopProject([{ details: {} }, { details: null }]), null);
  });
  it('picks highest count', () => {
    const ss = [
      { details: { project: 'ownmind' } },
      { details: { project: 'ring' } },
      { details: { project: 'ownmind' } }
    ];
    assert.equal(pickTopProject(ss), 'ownmind');
  });
  it('breaks ties by lexicographic order', () => {
    const ss = [
      { details: { project: 'ring' } },
      { details: { project: 'ownmind' } }
    ];
    assert.equal(pickTopProject(ss), 'ownmind');
  });
  it('returns null for empty sessions array', () => {
    assert.equal(pickTopProject([]), null);
  });
});

import express from 'express';

function buildApp({ queryFn, user }) {
  const fakeAdmin = (req, res, next) => {
    req.user = user;
    if (!user || !['admin','super_admin'].includes(user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
  const { createTeamOverviewRouter } = mod;
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

describe('GET /api/usage/admin/team-overview', () => {
  it('rejects non-admin with 403', async () => {
    const app = buildApp({ queryFn: async () => ({ rows: [] }), user: { id: 2, role: 'normal' } });
    const r = await request(app, { method: 'GET', path: '/' });
    assert.equal(r.status, 403);
  });

  it('returns scoreboard rows for admin', async () => {
    const sessionRows = [
      { user_id: 1, user_name: 'Vin', last_active_at: '2026-04-28T01:00:00Z',
        session_count: 3, sessions_json: [
          { details: { project: 'ownmind', rules_complied: ['IR-003'], rules_skipped: [] } },
          { details: { project: 'ownmind', rules_complied: ['IR-008'], rules_skipped: ['IR-009'] } },
          { details: { project: 'ring' } }
        ] }
    ];
    let calls = 0;
    const queryFn = async () => { calls++; return { rows: sessionRows }; };
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    const r = await request(app, { method: 'GET', path: '/' });
    assert.equal(r.status, 200);
    assert.equal(r.body.members.length, 1);
    const m = r.body.members[0];
    assert.equal(m.user_id, 1);
    assert.equal(m.session_count, 3);
    assert.equal(m.top_project, 'ownmind');
    assert.equal(m.rule_compliance.complied, 2);
    assert.equal(m.rule_compliance.triggered, 3);
    assert.ok(Math.abs(m.rule_compliance.rate - 2/3) < 1e-9);
  });

  it('rate is null when no session triggers rules', async () => {
    const queryFn = async () => ({ rows: [{
      user_id: 2, user_name: 'Adam', last_active_at: '2026-04-28T01:00:00Z',
      session_count: 1, sessions_json: [{ details: { project: 'ownmind' } }]
    }]});
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    const r = await request(app, { method: 'GET', path: '/' });
    const m = r.body.members[0];
    assert.equal(m.rule_compliance, null);
  });

  it('defaults to last 7 days when from/to not provided', async () => {
    let captured;
    const queryFn = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    await request(app, { method: 'GET', path: '/' });
    const from = new Date(captured.params[0]);
    const to = new Date(captured.params[1]);
    const diffDays = (to - from) / (24*60*60*1000);
    assert.ok(diffDays >= 6.99 && diffDays <= 7.01, `expected ~7 days, got ${diffDays}`);
  });

  it('response body includes range echo', async () => {
    const queryFn = async () => ({ rows: [] });
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    const r = await request(app, { method: 'GET', path: '/?from=2026-04-21T00:00:00Z&to=2026-04-28T00:00:00Z' });
    assert.equal(r.status, 200);
    assert.ok(r.body.range);
    assert.ok(r.body.range.from);
    assert.ok(r.body.range.to);
  });
});
