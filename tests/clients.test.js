import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { createAdminClientsRouter, loadClients } =
  await import('../src/routes/usage/admin-clients.js');

function buildApp({ queryFn, user, serverVersion = '1.17.0', now = () => new Date() }) {
  const fakeAdminAuth = (req, res, next) => {
    req.user = user;
    if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    next();
  };
  const router = createAdminClientsRouter({
    query: queryFn,
    adminAuth: fakeAdminAuth,
    serverVersion,
    now
  });
  const app = express();
  app.use(express.json());
  app.use('/api/usage/admin/clients', router);
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

function mkRow(user_id, user_name, email, role, tool = null, ver = null, hb_age_ms = null) {
  const lastAt = hb_age_ms == null ? null : new Date(Date.now() - hb_age_ms);
  return {
    user_id,
    user_name,
    email,
    role,
    tool,
    scanner_version: ver,
    machine: tool ? 'mac-test' : null,
    last_reported_at: lastAt,
    heartbeat_status: tool ? 'active' : null
  };
}

describe('GET /api/usage/admin/clients — auth', () => {
  it('rejects non-admin with 403', async () => {
    const app = buildApp({
      queryFn: async () => ({ rows: [] }),
      user: { id: 99, role: 'user' }
    });
    const res = await request(app, { path: '/api/usage/admin/clients' });
    assert.equal(res.status, 403);
  });

  it('allows admin', async () => {
    const app = buildApp({
      queryFn: async () => ({ rows: [] }),
      user: { id: 1, role: 'admin' }
    });
    const res = await request(app, { path: '/api/usage/admin/clients' });
    assert.equal(res.status, 200);
  });

  it('allows super_admin', async () => {
    const app = buildApp({
      queryFn: async () => ({ rows: [] }),
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, { path: '/api/usage/admin/clients' });
    assert.equal(res.status, 200);
  });
});

describe('loadClients — status classification', () => {
  it('classifies active / stale / offline by heartbeat age', async () => {
    const now = new Date();  // mkRow uses Date.now() so keep consistent
    const H = 60 * 60 * 1000;
    const query = async () => ({
      rows: [
        mkRow(1, 'A', 'a@x.com', 'user', 'claude-code', '1.17.0', 2 * H),    // active (<24h)
        mkRow(2, 'B', 'b@x.com', 'user', 'claude-code', '1.17.0', 30 * H),   // stale (24-48h)
        mkRow(3, 'C', 'c@x.com', 'user', 'claude-code', '1.17.0', 60 * H),   // offline (>48h)
        mkRow(4, 'D', 'd@x.com', 'user')                                     // not installed
      ]
    });
    const data = await loadClients({ query, serverVersion: '1.17.0', now });
    const byId = new Map(data.users.map((u) => [u.user_id, u]));

    assert.equal(byId.get(1).clients[0].status, 'active');
    assert.equal(byId.get(1).any_active, true);

    assert.equal(byId.get(2).clients[0].status, 'stale');
    assert.equal(byId.get(2).any_active, false);

    assert.equal(byId.get(3).clients[0].status, 'offline');
    assert.equal(byId.get(3).any_active, false);

    assert.equal(byId.get(4).installed, false);
    assert.equal(byId.get(4).clients.length, 0);
  });
});

describe('loadClients — needs_upgrade', () => {
  const now = new Date();

  it('flags older semver as needs_upgrade', async () => {
    const query = async () => ({
      rows: [
        mkRow(1, 'A', 'a@x.com', 'user', 'claude-code', '1.16.0', 3600_000),
        mkRow(2, 'B', 'b@x.com', 'user', 'claude-code', '1.17.0', 3600_000),
        mkRow(3, 'C', 'c@x.com', 'user', 'claude-code', '1.18.0', 3600_000)  // 比 server 新
      ]
    });
    const data = await loadClients({ query, serverVersion: '1.17.0', now });
    const byId = new Map(data.users.map((u) => [u.user_id, u]));

    assert.equal(byId.get(1).needs_upgrade, true, '1.16.0 < 1.17.0');
    assert.equal(byId.get(2).needs_upgrade, false, '1.17.0 == 1.17.0');
    assert.equal(byId.get(3).needs_upgrade, false, '1.18.0 > 1.17.0 不算');
  });

  it('treats null / unknown version as needs_upgrade', async () => {
    const query = async () => ({
      rows: [
        mkRow(1, 'A', 'a@x.com', 'user', 'claude-code', null, 3600_000),
        mkRow(2, 'B', 'b@x.com', 'user', 'claude-code', 'unknown', 3600_000)
      ]
    });
    const data = await loadClients({ query, serverVersion: '1.17.0', now });
    const byId = new Map(data.users.map((u) => [u.user_id, u]));
    assert.equal(byId.get(1).needs_upgrade, true);
    assert.equal(byId.get(2).needs_upgrade, true);
  });
});

describe('loadClients — multi-tool user', () => {
  const now = new Date();

  it('groups multiple tools under same user', async () => {
    const query = async () => ({
      rows: [
        mkRow(1, 'Vin', 'vin@x.com', 'super_admin', 'claude-code', '1.17.0', 3600_000),
        mkRow(1, 'Vin', 'vin@x.com', 'super_admin', 'codex', '1.16.0', 3600_000),
        mkRow(1, 'Vin', 'vin@x.com', 'super_admin', 'cursor', '1.17.0', 3600_000)
      ]
    });
    const data = await loadClients({ query, serverVersion: '1.17.0', now });
    assert.equal(data.users.length, 1);
    assert.equal(data.users[0].clients.length, 3);
    assert.equal(data.users[0].needs_upgrade, true, '有一個 tool 舊 = 整體要升級');
    assert.equal(data.users[0].any_active, true);
  });
});

describe('loadClients — coverage summary', () => {
  const now = new Date();

  it('computes coverage correctly across mixed states', async () => {
    const H = 60 * 60 * 1000;
    const query = async () => ({
      rows: [
        // user 1: active + 新版
        mkRow(1, 'A', 'a@x.com', 'user', 'claude-code', '1.17.0', 2 * H),
        // user 2: active + 舊版
        mkRow(2, 'B', 'b@x.com', 'user', 'claude-code', '1.16.0', 2 * H),
        // user 3: stale
        mkRow(3, 'C', 'c@x.com', 'user', 'claude-code', '1.17.0', 30 * H),
        // user 4: offline
        mkRow(4, 'D', 'd@x.com', 'user', 'claude-code', '1.17.0', 60 * H),
        // user 5: 未裝
        mkRow(5, 'E', 'e@x.com', 'user')
      ]
    });
    const data = await loadClients({ query, serverVersion: '1.17.0', now });
    assert.equal(data.coverage.total_users, 5);
    assert.equal(data.coverage.installed, 4);
    assert.equal(data.coverage.active, 2);   // user 1, 2
    assert.equal(data.coverage.stale, 1);    // user 3
    assert.equal(data.coverage.offline, 1);  // user 4
    assert.equal(data.coverage.not_installed, 1);
    assert.equal(data.coverage.needs_upgrade, 1);  // user 2
  });
});

describe('loadClients — response shape', () => {
  const now = new Date();

  it('includes server_version at top level', async () => {
    const query = async () => ({ rows: [] });
    const data = await loadClients({ query, serverVersion: '1.17.3', now });
    assert.equal(data.server_version, '1.17.3');
    assert.ok(data.coverage);
    assert.ok(Array.isArray(data.users));
  });
});

describe('loadClients — pre-release / malformed versions', () => {
  const now = new Date();

  it('pre-release version counts as lower than stable (needs upgrade)', async () => {
    const query = async () => ({
      rows: [
        mkRow(1, 'Beta', 'b@x.com', 'user', 'claude-code', '1.17.0-beta', 3600_000),
        mkRow(2, 'Dev',  'd@x.com', 'user', 'claude-code', '1.17.0-dev', 3600_000),
        mkRow(3, 'Stable', 's@x.com', 'user', 'claude-code', '1.17.0', 3600_000)
      ]
    });
    const data = await loadClients({ query, serverVersion: '1.17.0', now });
    const byId = new Map(data.users.map((u) => [u.user_id, u]));
    assert.equal(byId.get(1).needs_upgrade, true, '1.17.0-beta < 1.17.0');
    assert.equal(byId.get(2).needs_upgrade, true, '1.17.0-dev  < 1.17.0');
    assert.equal(byId.get(3).needs_upgrade, false);
  });

  it('malformed version falls back to [0,0,0,0] → treated as oldest', async () => {
    const query = async () => ({
      rows: [
        mkRow(1, 'Garbage', 'g@x.com', 'user', 'claude-code', 'garbage', 3600_000),
        mkRow(2, 'Partial', 'p@x.com', 'user', 'claude-code', '1.17', 3600_000)
      ]
    });
    const data = await loadClients({ query, serverVersion: '1.17.0', now });
    const byId = new Map(data.users.map((u) => [u.user_id, u]));
    assert.equal(byId.get(1).needs_upgrade, true);
    assert.equal(byId.get(2).needs_upgrade, true);
  });

  it('10.x > 1.x (numeric compare, not string)', async () => {
    const query = async () => ({
      rows: [
        mkRow(1, 'Old', 'o@x.com', 'user', 'claude-code', '1.9.0', 3600_000),
        mkRow(2, 'New', 'n@x.com', 'user', 'claude-code', '1.10.0', 3600_000)
      ]
    });
    const data = await loadClients({ query, serverVersion: '1.10.0', now });
    const byId = new Map(data.users.map((u) => [u.user_id, u]));
    assert.equal(byId.get(1).needs_upgrade, true, '1.9.0 < 1.10.0 (numeric)');
    assert.equal(byId.get(2).needs_upgrade, false);
  });
});

describe('createAdminClientsRouter — default SERVER_VERSION', () => {
  it('reads SERVER_VERSION from package.json when no override', async () => {
    const fakeAdminAuth = (req, res, next) => { req.user = { role: 'super_admin' }; next(); };
    const router = createAdminClientsRouter({
      query: async () => ({ rows: [] }),
      adminAuth: fakeAdminAuth
    });
    const app = express();
    app.use(express.json());
    app.use('/api/usage/admin/clients', router);

    const res = await request(app, { path: '/api/usage/admin/clients' });
    assert.equal(res.status, 200);
    assert.ok(res.body.server_version, 'server_version should be populated');
    assert.match(String(res.body.server_version), /^\d+\.\d+\.\d+/,
      '應為 package.json 讀出的 semver（可能含 -dev suffix）');
  });
});

describe('loadClients — sorting', () => {
  const now = new Date();

  it('puts needs_upgrade users first, then active, then not_installed last', async () => {
    const query = async () => ({
      rows: [
        mkRow(5, 'NotInstalled', 'n@x.com', 'user'),
        mkRow(1, 'NewVersion', 'new@x.com', 'user', 'claude-code', '1.17.0', 1000),
        mkRow(2, 'OldVersion', 'old@x.com', 'user', 'claude-code', '1.15.0', 1000)
      ]
    });
    const data = await loadClients({ query, serverVersion: '1.17.0', now });
    assert.equal(data.users[0].user_id, 2, 'needs_upgrade first');
    assert.equal(data.users[1].user_id, 1, 'installed + up-to-date');
    assert.equal(data.users[2].user_id, 5, 'not_installed last');
  });
});
