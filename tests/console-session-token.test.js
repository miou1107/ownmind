/**
 * v1.31.1 — the console logs in with a session that expires, not with the api_key, and the
 * content security policy is on. Security review 2026-10-03, item 12: the console was handed
 * the account's permanent key at login and kept it in localStorage, with the policy that
 * would have limited an injected script switched off.
 *
 * The SQL runs against a fake here, so these tests prove what is asked and in what order,
 * not that Postgres agrees; that is checked on the live database at deploy, as with the
 * other route-level changes in this repository.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SESSION_PREFIX, IDLE_MS, ABSOLUTE_MS, RECENT_LOGIN_MS, RETAIN_ENDED_MS, isSessionToken, hashToken,
  createSession, findSessionUser, revokeSession, revokeUserSessions, requireRecentLogin,
} from '../src/utils/web-session.js';
import auth from '../src/middleware/auth.js';
import { CONTENT_SECURITY_POLICY } from '../src/utils/content-security-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');

function recorder(rowsFor = () => []) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: flat(sql), params });
    const rows = rowsFor(flat(sql), params);
    return { rows, rowCount: rows.length };
  };
  return { query, calls };
}

describe('web-session', () => {
  it('a token is prefixed, random, and only its hash is stored', async () => {
    const { query, calls } = recorder();
    const now = Date.UTC(2026, 9, 3);
    const a = await createSession({ query, userId: 7, userAgent: 'x'.repeat(500), now });
    const b = await createSession({ query, userId: 7, now });
    assert.ok(a.startsWith(SESSION_PREFIX) && a.length > 40);
    assert.notEqual(a, b);
    // A login first clears out sessions that ended long ago; nothing else removes them.
    assert.match(calls[0].sql, /DELETE FROM web_sessions WHERE expires_at < \$1 OR revoked_at < \$1/);
    assert.equal(calls[0].params[0].getTime(), now - RETAIN_ENDED_MS);
    const insert = calls[1];
    assert.match(insert.sql, /INSERT INTO web_sessions/);
    assert.equal(insert.params[0], 7);
    assert.equal(insert.params[1], hashToken(a));
    assert.ok(!insert.params.includes(a), 'the token itself was written to the database');
    assert.equal(insert.params[2].getTime(), now + ABSOLUTE_MS, 'absolute expiry');
    assert.equal(insert.params[3].length, 200, 'user agent is capped');
  });

  it('a lookup enforces revocation, absolute expiry and the idle timeout in the query', async () => {
    const now = Date.UTC(2026, 9, 3);
    const { query, calls } = recorder((sql) => (sql.startsWith('SELECT')
      ? [{ id: 7, email: 'a@b', name: 'A', role: 'user', settings: null, created_at: null, session_id: 3 }]
      : []));
    const found = await findSessionUser({ query, token: `${SESSION_PREFIX}abc`, now });
    assert.deepEqual(found.user, { id: 7, email: 'a@b', name: 'A', role: 'user', settings: null, created_at: null });
    assert.equal(found.sessionId, 3);
    const select = calls[0];
    assert.match(select.sql, /s\.revoked_at IS NULL/);
    assert.match(select.sql, /s\.expires_at > NOW\(\)/);
    assert.match(select.sql, /s\.last_seen_at > \$2/);
    assert.equal(select.params[0], hashToken(`${SESSION_PREFIX}abc`));
    assert.equal(select.params[1].getTime(), now - IDLE_MS);
    assert.match(calls[1].sql, /UPDATE web_sessions SET last_seen_at = NOW\(\)/, 'last_seen is refreshed');
  });

  it('something that is not a session token never reaches the database', async () => {
    const { query, calls } = recorder();
    assert.equal(await findSessionUser({ query, token: '3f2a9c1e-7b4d-4e8a-9f61-0c5d2b8a7e14' }), null);
    assert.equal(await revokeSession({ query, token: 'an-api-key' }), 0, 'logout must never revoke a key');
    assert.equal(calls.length, 0);
    assert.equal(isSessionToken(undefined), false);
  });

  it('revoking an account spares only the session asked to be spared', async () => {
    const { query, calls } = recorder();
    await revokeUserSessions({ query, userId: 7 });
    await revokeUserSessions({ query, userId: 7, exceptSessionId: 3 });
    assert.doesNotMatch(calls[0].sql, /id <>/);
    assert.deepEqual(calls[0].params, [7]);
    assert.match(calls[1].sql, /id <> \$2/);
    assert.deepEqual(calls[1].params, [7, 3]);
  });
});

describe('auth middleware', () => {
  const run = async (header, rowsFor) => {
    const { query, calls } = recorder(rowsFor);
    const req = { headers: { authorization: header }, path: '/x' };
    let status = null; let nextCalled = false;
    const res = { status(s) { status = s; return this; }, json() { return this; } };
    await auth(req, res, () => { nextCalled = true; }, { query, logger: { warn() {}, error() {} } });
    return { req, status, nextCalled, calls };
  };

  it('a live session authenticates and carries its id', async () => {
    const r = await run(`Bearer ${SESSION_PREFIX}abc`, (sql) => (sql.startsWith('SELECT')
      ? [{ id: 7, email: 'a@b', name: 'A', role: 'admin', settings: null, created_at: null, session_id: 9 }]
      : []));
    assert.equal(r.nextCalled, true);
    assert.equal(r.req.user.role, 'admin');
    assert.equal(r.req.sessionId, 9);
    assert.ok(!r.calls.some((c) => /WHERE api_key/.test(c.sql)), 'a session must not be looked up as a key');
  });

  it('a dead session is a 401', async () => {
    const r = await run(`Bearer ${SESSION_PREFIX}gone`, () => []);
    assert.equal(r.status, 401);
    assert.equal(r.nextCalled, false);
  });

  it('an api_key still works exactly as before', async () => {
    const r = await run('Bearer 3f2a9c1e-7b4d-4e8a-9f61-0c5d2b8a7e14', (sql) => (/WHERE api_key/.test(sql)
      ? [{ id: 1, email: 'x', name: 'X', role: 'user', settings: null, created_at: null }] : []));
    assert.equal(r.nextCalled, true);
    assert.equal(r.req.sessionId, undefined);
    assert.ok(!r.calls.some((c) => /web_sessions/.test(c.sql)));
  });
});

describe('routes', () => {
  const me = read('src', 'routes', 'me.js');

  it('login and first-password hand out a session, never the api_key', () => {
    const fp = read('src', 'utils', 'first-password.js');
    const body = fp.slice(fp.indexOf('export function loginResponseFor'), fp.indexOf('export function firstPasswordRefusal'));
    assert.doesNotMatch(body, /api_key/);
    assert.match(body, /session_token: sessionToken/);
    const login = me.slice(me.indexOf("router.post('/login'"), me.indexOf("router.post('/first-password'"));
    assert.match(login, /must_change_password\s*\?\s*undefined\s*:\s*await createSession/, 'no session for a temporary password');
    const first = me.slice(me.indexOf("router.post('/first-password'"), me.indexOf('router.use(auth)'));
    assert.ok(first.indexOf('createSession(') > first.indexOf('UPDATE users SET password_hash'), 'a session only after the password is replaced');
  });

  it('logout exists, behind auth', () => {
    const at = me.indexOf("router.post('/logout'");
    assert.ok(at > me.indexOf('router.use(auth)'));
    assert.match(me.slice(at, at + 600), /revokeSession\(/);
  });

  it('every password change ends the account\'s other logins', () => {
    const change = me.slice(me.indexOf("router.post('/change-password'"));
    assert.match(change.slice(0, 2500), /revokeUserSessions\(\{ query, userId: req\.user\.id, exceptSessionId: req\.sessionId/);
    assert.match(read('src', 'routes', 'admin-password-reset.js'), /revokeUserSessions\(\{ query, userId: targetId \}\)/);
    const admin = read('src', 'routes', 'admin.js');
    assert.match(admin, /revokeUserSessions\(\{ query, userId: targetId, exceptSessionId: isSelf/);
    assert.match(admin, /revokeUserSessions\(\{ query, userId: user\.id \}\)/, 'the recovery setup too');
  });

  it('the recovery setup no longer returns the api_key', () => {
    const admin = read('src', 'routes', 'admin.js');
    const setup = admin.slice(admin.indexOf("'setup_password'"), admin.indexOf("'setup_password'") + 600);
    assert.doesNotMatch(setup, /api_key: user\.api_key/);
  });
});

describe('content security policy', () => {
  it('is on, and scripts are same-origin only', () => {
    const app = read('src', 'app.js');
    assert.doesNotMatch(app, /contentSecurityPolicy:\s*false/);
    assert.match(app, /helmet\(\{ contentSecurityPolicy: CONTENT_SECURITY_POLICY \}\)/);
    const d = CONTENT_SECURITY_POLICY.directives;
    assert.deepEqual(d.scriptSrc, ["'self'"]);
    assert.deepEqual(d.scriptSrcAttr, ["'none'"]);
    assert.deepEqual(d.connectSrc, ["'self'"]);
    assert.deepEqual(d.objectSrc, ["'none'"]);
    assert.deepEqual(d.frameAncestors, ["'none'"]);
    for (const v of Object.values(d).flat()) assert.doesNotMatch(v, /unsafe-eval|\*/);
  });

  it('the setup wizard has no inline script left for the policy to block', () => {
    const html = read('src', 'public', 'setup.html');
    assert.doesNotMatch(html, /<script>|onclick=|onload=|onsubmit=/);
    assert.match(html, /<script src="setup\.js"><\/script>/);
    assert.match(read('src', 'app.js'), /app\.get\(\['\/setup\.js'/);
    const js = read('src', 'public', 'setup.js');
    assert.match(js, /getElementById\('copy-api-key'\)\.addEventListener/);
  });
});

describe('console', () => {
  it('stores the session token, and forgets a pre-v1.31.1 key on load', async () => {
    const store = new Map([['ownmind.api_key', 'an-old-permanent-key']]);
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    try {
      const auth = await import(`../client/src/api/auth.js?fresh=${Date.now()}`);
      assert.equal(store.has('ownmind.api_key'), false, 'the old key stayed in the browser');
      auth.setSessionToken(`${SESSION_PREFIX}t`);
      assert.equal(store.get('ownmind.session'), `${SESSION_PREFIX}t`);
    } finally {
      delete globalThis.localStorage;
    }
  });

  it('logs in with session_token and logs out on the server too', () => {
    const login = read('client', 'src', 'pages', 'LoginPage.jsx');
    assert.doesNotMatch(login, /data\.api_key|data\?\.api_key/);
    assert.match(login, /setSessionToken\(r\.data\.session_token\)/);
    const session = read('client', 'src', 'session', 'SessionContext.jsx');
    const logout = session.slice(session.indexOf('const logout ='));
    assert.ok(logout.indexOf("apiPost('/api/me/logout')") < logout.indexOf('clearSessionToken()'));
    assert.doesNotMatch(logout.slice(0, logout.indexOf('}, [])')), /\.finally\(|await /,
      'the browser must forget the login without waiting for the network');
    assert.doesNotMatch(read('client', 'src', 'pages', 'Admin', 'TeamPage.jsx'), /setSessionToken/,
      'rotating a key must not be written into the browser as a login');
  });
});

describe('review round: a session must not turn into the permanent key', () => {
  const res = () => {
    const r = { code: null, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  };

  it('an api_key caller is never asked to log in again', () => {
    assert.equal(requireRecentLogin({}, res()), true);
  });

  it('a session only within RECENT_LOGIN_MS of its login', () => {
    const now = Date.UTC(2026, 9, 3, 12);
    const fresh = { sessionId: 1, sessionCreatedAt: new Date(now - RECENT_LOGIN_MS + 1000) };
    assert.equal(requireRecentLogin(fresh, res(), now), true);
    const stale = { sessionId: 1, sessionCreatedAt: new Date(now - RECENT_LOGIN_MS - 1000) };
    const r = res();
    assert.equal(requireRecentLogin(stale, r, now), false);
    assert.equal(r.code, 403);
    assert.equal(r.body.reauth_required, true);
    const unknown = res();
    assert.equal(requireRecentLogin({ sessionId: 1 }, unknown, now), false, 'no login time is not a fresh login');
  });

  it('every route that answers with an api_key asks for it, before doing anything', () => {
    const rotate = read('src', 'routes', 'api-key-rotate.js');
    for (const route of ["router.post('/me/rotate-key'", "router.post('/admin/users/:id/rotate-key'"]) {
      const at = rotate.indexOf(route);
      const body = rotate.slice(at, at + 400);
      assert.match(body, /if \(!requireRecentLogin\(req, res\)\) return;/, route);
      assert.ok(body.indexOf('requireRecentLogin') < body.indexOf('try {'), route);
    }
    const reveal = read('src', 'routes', 'admin-api-key.js');
    const at = reveal.indexOf("router.get('/:id/api-key'");
    assert.ok(reveal.indexOf('requireRecentLogin(req, res)', at) < reveal.indexOf('SELECT id, role, api_key', at));
  });

  it('the auth middleware passes the login time on', async () => {
    const created = new Date(Date.UTC(2026, 9, 3));
    const { query } = recorder((sql) => (sql.startsWith('SELECT')
      ? [{ id: 7, email: 'a', name: 'A', role: 'admin', settings: null, created_at: null, session_id: 9, session_created_at: created }]
      : []));
    const req = { headers: { authorization: `Bearer ${SESSION_PREFIX}x` }, path: '/x' };
    await auth(req, { status() { return this; }, json() { return this; } }, () => {}, { query, logger: { warn() {}, error() {} } });
    assert.equal(req.sessionCreatedAt.getTime(), created.getTime());
    assert.equal('session_created_at' in req.user, false);
  });
});

describe('review round: smaller items', () => {
  it('an admin reset ends sessions before it changes the password', () => {
    const src = read('src', 'routes', 'admin-password-reset.js');
    assert.ok(src.indexOf('revokeUserSessions(') < src.indexOf('SET password_hash = $1'),
      'failing after the update would lose a temporary password nobody was shown');
  });

  it('the recovery script ends sessions too', () => {
    assert.match(read('scripts', 'reset-admin-password.js'), /UPDATE web_sessions SET revoked_at = NOW\(\) WHERE user_id = \$1/);
  });

  it('the wizard script is served at /setup/ as well as /setup', () => {
    assert.match(read('src', 'app.js'), /app\.get\(\['\/setup\.js', '\/setup\/setup\.js'\]/);
  });

  it('a wrong old password is a 400, so the console does not throw its login away', () => {
    const admin = read('src', 'routes', 'admin.js');
    const at = admin.indexOf("'舊密碼錯誤'");
    assert.match(admin.slice(at - 60, at), /status\(400\)/);
  });
});
