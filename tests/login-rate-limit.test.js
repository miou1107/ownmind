// v1.26.60 — the console's login is behind the brute-force limiter.
//
// The defect this covers is an omission, not a mistake. `authLimiter` (10 attempts per 15
// minutes) has guarded `POST /api/admin/login` since the legacy console existed. v1.20
// introduced `POST /api/me/login` to replace it and never added the limiter, so from that
// release every login in the product moved to an unthrottled endpoint. Nothing failed, so
// nobody looked: `/api` alone allows 200 requests a minute, which is a throughput ceiling,
// not a password-guessing one — 200 a minute is roughly 288,000 attempts a day.
//
// Found by deleting `/api/admin/login` in this release and asking what it had been doing.
//
// Driven rather than asserted against the source. A regex over app.js would pass on a
// limiter mounted after the router, or on one built with `max: Infinity`.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let app;

before(async () => {
  // Small enough to exhaust in three requests. Read at import time, so it must be set
  // before src/app.js is loaded.
  process.env.AUTH_RATE_LIMIT_MAX = '2';
  process.env.ENCRYPTION_KEY ||= 'test-encryption-key-at-least-32-chars-long';
  ({ default: app } = await import('../src/app.js'));
});

/** POST a login attempt and return the status. The DB is unreachable here, which is fine:
 *  the limiter runs before the handler, so a throttled request never reaches it. */
async function attemptFull(path) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      try {
        const { port } = srv.address();
        const r = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' }),
        });
        let body = {};
        try { body = await r.json(); } catch { /* not json */ }
        resolve({ status: r.status, body });
      } catch (err) {
        reject(err);
      } finally {
        srv.close();
      }
    });
  });
}

describe('v1.26.60 — POST /api/me/login is rate limited', () => {
  it('refuses further attempts once the ceiling is reached', async () => {
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      seen.push((await attemptFull('/api/me/login')).status);
    }
    assert.ok(
      seen.includes(429),
      `the console login must be throttled; got statuses ${JSON.stringify(seen)}`,
    );
    // The limit bites rather than merely existing: the tail is all rejections.
    assert.equal(seen[seen.length - 1], 429);
  });

  it('a path that escapes the limiter also escapes the login handler', async () => {
    // Raised in adversarial review as a brute-force bypass: `app.use('/api/me/login')`
    // matches on an exact prefix, so `/api/me//login` never reaches the limiter, while
    // Express's router collapses the double slash and would still route it.
    //
    // Measured, and the second half is wrong. The double slash misses the login route
    // too, falls through to the `router.use(auth)` section below it, and is rejected for
    // having no bearer token — so no password is ever checked and there is nothing to
    // brute force. Pinned here because that is a subtle thing to depend on: moving the
    // login route below `router.use(auth)`, or normalising paths earlier, would turn this
    // into the real bypass the review described.
    const { status, body } = await attemptFull('/api/me//login');
    assert.equal(status, 401);
    assert.match(body.error || '', /認證令牌/,
      'must be rejected by the auth middleware, not answered as a login attempt');
    assert.notEqual(body.error, '帳號或密碼錯誤',
      'if this ever reads as a failed login, the limiter is being bypassed for real');
  });

  it('the retired /api/admin/login no longer authenticates anyone', async () => {
    // It answers 401, but from `adminAuth` — the router's own guard, which runs before
    // routing and rejects an unauthenticated caller whatever path they asked for. That is
    // the opposite of what it used to do: a *login* endpoint by definition accepts
    // unauthenticated callers. So the check is on the body, not the status: no credential
    // comes back, and neither does the `requiresSetup` signal that told any caller an
    // account exists but has no password.
    const { status, body } = await attemptFull('/api/admin/login');
    assert.notEqual(status, 200, '/api/admin/login must not succeed');
    assert.equal(body.api_key, undefined, 'no credential may be issued');
    assert.equal(body.requiresSetup, undefined, 'the account-state signal must be gone');
  });
});
