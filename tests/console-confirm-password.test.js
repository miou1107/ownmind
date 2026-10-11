/**
 * POST /api/me/confirm-password — typing the password again counts as a fresh login.
 *
 * Copying a key or an install prompt needs a login from the last 15 minutes. Before this,
 * the only way back in after that was logging out and in again, and the key copy button
 * did not even say so. Now the console asks for the password in place; a correct one marks
 * this session as just confirmed and the copy goes ahead.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import bcrypt from 'bcrypt';
import { createConfirmPasswordRouter } from '../src/routes/me-confirm-password.js';

const HASH = bcrypt.hashSync('right-password', 4);

function run({ body, sessionId = 9, userId = 7 }) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT')) return { rows: [{ password_hash: HASH }] };
    return { rows: [], rowCount: 1 };
  };
  const r = createConfirmPasswordRouter({
    query,
    auth: (req, _res, next) => { req.user = { id: userId }; req.sessionId = sessionId; next(); },
    logger: { warn() {}, error() {}, info() {} },
  });
  return new Promise((resolve) => {
    const res = {
      code: 200,
      status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, body: b, calls }); return this; },
    };
    r.handle({ method: 'POST', url: '/', body, headers: {} }, res, () => resolve({ code: 404, calls }));
  });
}

describe('confirm-password', () => {
  it('a correct password marks this session as just confirmed', async () => {
    const out = await run({ body: { password: 'right-password' } });
    assert.equal(out.code, 200);
    const update = out.calls.find((c) => c.sql.startsWith('UPDATE web_sessions'));
    assert.ok(update, 'the session row must be updated');
    assert.match(update.sql, /password_confirmed_at = NOW\(\)/);
    assert.deepEqual(update.params, [9]);
  });

  it('a wrong password is a 400 and changes nothing', async () => {
    const out = await run({ body: { password: 'wrong' } });
    assert.equal(out.code, 400, 'not 401: the console treats 401 as "logged out"');
    assert.equal(out.calls.some((c) => c.sql.startsWith('UPDATE')), false);
  });

  it('an empty password is a 400 without a lookup', async () => {
    const out = await run({ body: {} });
    assert.equal(out.code, 400);
    assert.equal(out.calls.length, 0);
  });

  it('an api_key caller has no session to confirm', async () => {
    const out = await run({ body: { password: 'right-password' }, sessionId: null });
    assert.equal(out.code, 400);
    assert.equal(out.calls.some((c) => c.sql.startsWith('UPDATE')), false);
  });
});

describe('confirm-password wiring', () => {
  const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8');

  it('sits behind a password-guessing limiter that counts only wrong passwords', () => {
    const app = read('src', 'app.js');
    const at = app.indexOf("app.use('/api/me/confirm-password', rateLimit(");
    assert.ok(at > 0, 'the route must have its own limiter');
    assert.match(app.slice(at, at + 300), /skipSuccessfulRequests: true/);
    assert.ok(at < app.indexOf("app.use('/api/me/confirm-password', confirmPasswordRoutes)"));
  });

  it('the login time a session is judged by includes the last confirmation', () => {
    assert.match(read('src', 'utils', 'web-session.js'),
      /GREATEST\(s\.created_at, s\.password_confirmed_at\) AS session_created_at/);
  });

  it('the column exists', () => {
    const files = fs.readdirSync(new URL('../db/', import.meta.url));
    assert.ok(files.some((f) => /^\d+_.*\.sql$/.test(f)
      && /ADD COLUMN IF NOT EXISTS password_confirmed_at TIMESTAMPTZ/.test(read('db', f))));
  });
});
