/**
 * Deactivating an account: the person can no longer use OwnMind, their data stays, and
 * team pages stop counting them.
 *
 * 2026-10-11: a colleague left. The only choices were deleting the account, which takes
 * every memory with it, or leaving it as it was, which keeps a working key and keeps the
 * person in every team count ("hasn't used it in two weeks"). Vin asked for an inactive
 * state instead.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAccountStatusRouter } from '../src/routes/admin-account-status.js';

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8');

function run(path, { actor = { id: 1, role: 'super_admin' }, target = { id: 6, role: 'user', email: 'm@x', deactivated_at: null } } = {}) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT')) return { rows: target ? [target] : [] };
    return { rows: [{ id: target && target.id }], rowCount: 1 };
  };
  const router = createAccountStatusRouter({
    query,
    adminAuth: (req, _res, next) => { req.user = actor; next(); },
    logger: { info() {}, warn() {}, error() {} },
  });
  return new Promise((resolve) => {
    const res = {
      code: 200,
      setHeader() {},
      status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, body: b, calls }); return this; },
    };
    router.handle({ method: 'POST', url: path, headers: {}, body: {} }, res, () => resolve({ code: 404, calls }));
  });
}

describe('deactivate', () => {
  it('marks the account, replaces its key and ends its console logins', async () => {
    const out = await run('/6/deactivate');
    assert.equal(out.code, 200);
    const update = out.calls.find((c) => c.sql.startsWith('UPDATE users'));
    assert.match(update.sql, /deactivated_at = NOW\(\)/);
    assert.match(update.sql, /api_key = \$/, 'the old key must stop working at once');
    assert.ok(update.params.includes(6) && update.params.includes(1));
    assert.ok(out.calls.some((c) => /UPDATE web_sessions SET revoked_at = NOW\(\)/.test(c.sql)));
    assert.ok(out.calls.some((c) => c.sql.startsWith('INSERT INTO audit_logs') && c.params.includes('deactivate_user')));
  });

  it('only a super_admin may do it', async () => {
    const out = await run('/6/deactivate', { actor: { id: 2, role: 'admin' } });
    assert.equal(out.code, 403);
    assert.equal(out.calls.some((c) => c.sql.startsWith('UPDATE')), false);
  });

  it('not yourself, and not the first account', async () => {
    assert.equal((await run('/1/deactivate', { target: { id: 1, role: 'super_admin' } })).code, 400);
    assert.equal((await run('/3/deactivate', { actor: { id: 3, role: 'super_admin' }, target: { id: 3, role: 'super_admin' } })).code, 400);
  });

  it('an unknown account is a 404', async () => {
    assert.equal((await run('/99/deactivate', { target: null })).code, 404);
  });
});

describe('reactivate', () => {
  it('clears the mark and nothing else', async () => {
    const out = await run('/6/reactivate', { target: { id: 6, role: 'user', deactivated_at: new Date() } });
    assert.equal(out.code, 200);
    const update = out.calls.find((c) => c.sql.startsWith('UPDATE users'));
    assert.match(update.sql, /deactivated_at = NULL/);
    assert.doesNotMatch(update.sql, /api_key/);
    assert.ok(out.calls.some((c) => c.sql.startsWith('INSERT INTO audit_logs') && c.params.includes('reactivate_user')));
  });
});

describe('a deactivated account cannot get in', () => {
  it('by api_key', () => {
    assert.match(read('src', 'middleware', 'auth.js'), /FROM users WHERE api_key = \$1 AND deactivated_at IS NULL/);
  });
  it('by a console login that was already open', () => {
    assert.match(read('src', 'utils', 'web-session.js'), /AND u\.deactivated_at IS NULL/);
  });
  it('by logging in again', () => {
    const me = read('src', 'routes', 'me.js');
    const at = me.indexOf("router.post('/login'");
    assert.match(me.slice(at, at + 2500), /user\.deactivated_at/);
  });
});

describe('team pages stop counting a deactivated account', () => {
  // Every query that lists the team as a roster. A new one should join this list.
  const rosters = [
    ['src/routes/usage/team-overview.js', 'u'],
    ['src/routes/usage/team-stats.js', 'u'],
    ['src/routes/usage/admin-clients.js', 'u'],
    ['src/routes/me-overview.js', 'u'],
    ['src/routes/me-narrative.js', 'u'],
    ['src/routes/activity.js', 'u'],
    ['src/jobs/install-check-alerts.js', 'u'],
    ['src/jobs/collector-silence-alerts.js', 'u'],
  ];
  it('the team half of /api/me/report and its audit findings', () => {
    const me = read('src', 'routes', 'me.js');
    for (const q of ['const teamUsersQ', 'const allVersionsQ', 'const ir027Q', 'const teamBlindQ']) {
      const at = me.indexOf(q);
      assert.ok(at > 0, q);
      assert.match(me.slice(at, at + 1200), /u\.deactivated_at IS NULL/, q);
    }
  });
  for (const [file] of rosters) {
    it(file, () => {
      assert.match(read(file), /u\.deactivated_at IS NULL/);
    });
  }
  it('the weekly report skips them', () => {
    assert.match(read('src', 'jobs', 'weeklyReport.js'), /role IN \('admin', 'user'\) AND deactivated_at IS NULL/);
  });
  it('the user list says who is deactivated', () => {
    assert.match(read('src', 'routes', 'admin.js'), /deactivated_at FROM users ORDER BY/);
  });
});

describe('wiring', () => {
  it('the column exists', () => {
    const files = fs.readdirSync(new URL('../db/', import.meta.url));
    assert.ok(files.some((f) => /^\d+_.*\.sql$/.test(f)
      && /ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ/.test(read('db', f))));
  });
  it('mounted ahead of the admin router', () => {
    const app = read('src', 'app.js');
    const at = app.indexOf("app.use('/api/admin/users', accountStatusRoutes)");
    assert.ok(at > 0);
    assert.ok(at < app.indexOf("app.use('/api/admin', "));
  });
});
