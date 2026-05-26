import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * v1.17.68 — auth.js 401 observability pipe (IR-038)
 *
 * Background: from 2026-03-26 (account creation) to 2026-05-08 Adam kept hitting
 * 401 because his settings.json had OWNMIND_API_KEY set to the literal string
 * "--update" (a pre-v1.17.9 install.ps1 issue: it did not filter flag-like args
 * out of the legacy slot). During that window token_events / install_check_logs
 * were empty and the scanner kept 401'ing — nobody noticed because the server's
 * auth-401 path had no structured log. Admins looking at docker logs only saw
 * the access log line "POST /api/usage/events 401 3ms" — no way to tell who it
 * was, no key prefix to cross-reference against the users table.
 *
 * Fix: the auth.js 401 path calls logger.warn('auth_failed', {...}) with
 * route / ip / masked key prefix-suffix / ua, and exports maskApiKey() as a
 * pure function for test coverage.
 */

describe('v1.17.68 — auth.js maskApiKey() pure function', () => {
  it('module must export maskApiKey', async () => {
    const mod = await import('../src/middleware/auth.js');
    assert.equal(typeof mod.maskApiKey, 'function',
      'auth.js must export maskApiKey for observability / tests');
  });

  it('empty / null / undefined → "<empty>"', async () => {
    const { maskApiKey } = await import('../src/middleware/auth.js');
    assert.equal(maskApiKey(''), '<empty>');
    assert.equal(maskApiKey(null), '<empty>');
    assert.equal(maskApiKey(undefined), '<empty>');
  });

  it('length < 12 → "<too-short:N>" (cannot leak the full short key)', async () => {
    const { maskApiKey } = await import('../src/middleware/auth.js');
    assert.equal(maskApiKey('abc'), '<too-short:3>');
    assert.equal(maskApiKey('1234567'), '<too-short:7>');
    assert.equal(maskApiKey('12345678901'), '<too-short:11>');
  });

  it("Adam's --update (8 chars) takes the too-short branch, no full text leakage", async () => {
    const { maskApiKey } = await import('../src/middleware/auth.js');
    const out = maskApiKey('--update');
    // v1.17.68 reviewer note: the original len < 8 threshold let an 8-char key
    // fall through slice(0,4)+'...'+slice(-4) → '--up...date'; remove the three
    // dots and you reconstruct the original. Raising the threshold to 12
    // forces 8-char keys into <too-short:8> so admins never see the full key in logs.
    assert.equal(out, '<too-short:8>',
      'an 8-char key must take the too-short branch; mask must not allow prefix...suffix reconstruction');
    assert.ok(!out.includes('update'), 'must not contain any substring of the original');
    assert.ok(!out.includes('--up'), 'must not contain any substring of the original');
  });

  it('len=12 boundary: takes the prefix...suffix branch and actually masks 4 middle chars', async () => {
    const { maskApiKey } = await import('../src/middleware/auth.js');
    const out = maskApiKey('aaaaXXXXbbbb');
    assert.equal(out, 'aaaa...bbbb (len=12)');
    // The XXXX middle is genuinely covered by the dots.
    assert.ok(!out.includes('XXXX'), 'middle 4 chars must be masked');
  });

  it('UUID v4 format → "first4...last4 (len=N)"', async () => {
    const { maskApiKey } = await import('../src/middleware/auth.js');
    const uuid = 'eb801d3f-03a3-4592-aee7-a54eb86fe0dc';
    const out = maskApiKey(uuid);
    assert.match(out, /^eb80/, 'mask should start with the first 4 chars');
    assert.match(out, /e0dc/, 'mask should contain the last 4 chars');
    assert.match(out, /len=36/, 'mask should include the length');
    assert.ok(!out.includes('1d3f-03a3-4592-aee7-a54eb86f'),
      'mask must not contain the middle of the key (prevents PII / key leak)');
  });
});

describe('v1.17.68 — auth middleware 401 path logger.warn shape', () => {
  it('on 401, logger.warn("auth_failed", {...}) must include route + masked_key + ip + ua', async () => {
    const auth = (await import('../src/middleware/auth.js')).default;

    // Collect logger.warn calls.
    const warnCalls = [];
    const fakeLogger = {
      warn: (msg, meta) => warnCalls.push({ msg, meta }),
      error: () => {},
    };

    // Collect query calls; return 0 rows to simulate "key not found".
    const fakeQuery = async () => ({ rows: [] });

    // Inject: auth.js must support testHooks that injects logger + query.
    // (We do not rely on global module mocking because node:test lacks jest-like capability.)
    const req = {
      headers: {
        authorization: 'Bearer --update',
        'user-agent': 'OwnMindScanner/1.17.66 node/v22.0.0',
      },
      path: '/api/usage/events',
      ip: '203.0.113.45',
    };
    let statusCode = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json() { return this; },
    };
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    await auth(req, res, next, { logger: fakeLogger, query: fakeQuery });

    assert.equal(statusCode, 401, 'should be 401');
    assert.equal(nextCalled, false, 'next() should not be called');
    assert.equal(warnCalls.length, 1, 'logger.warn should be called exactly once');
    assert.equal(warnCalls[0].msg, 'auth_failed');
    const meta = warnCalls[0].meta;
    assert.equal(meta.route, '/api/usage/events');
    assert.equal(meta.ip, '203.0.113.45');
    // v1.17.68 reviewer note: 8-char keys must not take the prefix...suffix branch
    // (reconstructible to the original); they take <too-short:8> instead.
    assert.equal(meta.masked_key, '<too-short:8>');
    assert.ok(!meta.masked_key.includes('update'), 'must not contain any substring of the original');
    assert.match(meta.ua, /OwnMindScanner/);
  });

  it('"no auth token provided" path must also log (no Bearer header)', async () => {
    const auth = (await import('../src/middleware/auth.js')).default;
    const warnCalls = [];
    const fakeLogger = { warn: (m, meta) => warnCalls.push({ m, meta }), error: () => {} };
    const req = { headers: {}, path: '/api/memory/init', ip: '203.0.113.46' };
    let statusCode = null;
    const res = { status(c) { statusCode = c; return this; }, json() { return this; } };
    await auth(req, res, () => {}, { logger: fakeLogger, query: async () => ({ rows: [] }) });
    assert.equal(statusCode, 401);
    assert.equal(warnCalls.length, 1, 'no Bearer should also log (it is still a 401 case)');
    assert.equal(warnCalls[0].meta.masked_key, '<no-bearer>');
  });
});
