/**
 * #127 — a connection failure has to say which failure it was.
 *
 * `ownmind_log_session` failed three times with exactly `[OwnMind v1.30.20] Error report：fetch
 * failed`, while curl against the same URL with the same credentials in the same second
 * returned 201. Node's fetch rejects with the cause discarded, and the tool printed that
 * string and nothing else: no method, no URL, no elapsed time, no `err.cause` — which is the
 * only place the actual fault (`ECONNRESET`, a connect timeout, a TLS error) is recorded.
 *
 * Two things are asserted here. The message now carries the cause, and offline mode still
 * recognises the error — `isNetworkError` is what falls back to the local cache, and it used
 * to survive purely on the words "fetch failed" being in the message.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { describeFetchFailure, fetchFailureCode } from '../mcp/lib/fetch-failure.js';
import { isNetworkError } from '../mcp/offline.js';
// v1.26.158: `fetch` refuses the WHATWG blocked ports outright, listening or not, and about
// one draw in a few hundred lands on one. This test needs a refused *connection*, so a blocked
// port would replace ECONNREFUSED with "bad port" and quietly test the wrong thing.
import { FETCH_BLOCKED_PORTS } from './helpers/app-server.js';

/** An error shaped the way undici rejects: a bare outer message, the fault on `cause`. */
function undiciStyle(code, message, name = 'Error') {
  const inner = Object.assign(new Error(message), { code, name });
  return new TypeError('fetch failed', { cause: inner });
}

describe('describeFetchFailure', () => {
  it('names the call, the elapsed time and the cause', () => {
    const said = describeFetchFailure(
      undiciStyle('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error', 'ConnectTimeoutError'),
      { method: 'POST', url: 'https://example.test/ownmind/api/session', elapsedMs: 2013 },
    );
    assert.match(said, /POST https:\/\/example\.test\/ownmind\/api\/session/);
    assert.match(said, /after 2013ms/);
    assert.match(said, /ConnectTimeoutError/);
    assert.match(said, /UND_ERR_CONNECT_TIMEOUT/);
  });

  it('still opens with the words offline mode matches on', () => {
    // isNetworkError reads the message. Losing this prefix would take the cache fallback with
    // it, which is a worse bug than the one being fixed.
    const said = describeFetchFailure(undiciStyle('ECONNRESET', 'read ECONNRESET'), {
      method: 'GET', url: 'https://example.test/api/version', elapsedMs: 12,
    });
    assert.ok(said.startsWith('fetch failed'), said);
  });

  it('adds nothing it does not have', () => {
    // A cause-less error with no call details must not grow invented punctuation.
    assert.equal(describeFetchFailure(new Error('fetch failed')), 'fetch failed');
  });

  it('a cause cycle does not hang it', () => {
    const a = new Error('outer');
    const b = new Error('inner');
    a.cause = b;
    b.cause = a;
    assert.equal(typeof describeFetchFailure(a, { method: 'GET', url: 'x' }), 'string');
  });

  it('reads the code from wherever in the chain it sits', () => {
    assert.equal(fetchFailureCode(undiciStyle('ECONNREFUSED', 'connect ECONNREFUSED')), 'ECONNREFUSED');
    assert.equal(fetchFailureCode(new Error('nothing here')), '');
  });
});

describe('isNetworkError reads the cause chain', () => {
  it('an error whose only signal is a code on the cause still counts', () => {
    // The case the old implementation missed: it read err.code, which undici leaves undefined,
    // and err.message, which here says nothing about the network.
    const wrapped = new Error('request to the session endpoint did not complete', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    assert.equal(isNetworkError(wrapped), true);
  });

  it('the wrapped error this fix produces is still recognised', () => {
    const original = undiciStyle('ECONNRESET', 'read ECONNRESET');
    const wrapped = new Error(
      describeFetchFailure(original, { method: 'POST', url: 'https://example.test/api/session', elapsedMs: 8 }),
      { cause: original },
    );
    assert.equal(isNetworkError(wrapped), true);
  });

  it('reverse control: a server that answered is not a network error', () => {
    // Otherwise "walk the chain and say yes" would pass every test above while turning every
    // HTTP 400 into a silent cache read.
    assert.equal(isNetworkError(new Error('HTTP 400: title is required')), false);
    assert.equal(isNetworkError(new Error('HTTP 401: invalid api key')), false);
    assert.equal(isNetworkError(null), false);
  });
});

describe('against a real dead socket', () => {
  it('a refused connection produces a message a person can act on', async () => {
    // A port nothing is listening on, obtained by opening one and closing it — a hardcoded
    // number is a port somebody's dev server is using. Redrawn if the OS hands back one that
    // fetch will not dial, for the reason in the import above.
    let port = 0;
    for (let attempt = 0; attempt < 20 && port === 0; attempt++) {
      const probe = net.createServer();
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const drawn = probe.address().port;
      await new Promise((resolve) => probe.close(resolve));
      if (!FETCH_BLOCKED_PORTS.has(drawn)) port = drawn;
    }
    assert.notEqual(port, 0, 'twenty draws in a row were ports fetch refuses, which cannot be right');

    const url = `http://127.0.0.1:${port}/api/session`;
    const startedAt = Date.now();
    let said = '';
    let caught = null;
    try {
      await fetch(url, { method: 'POST' });
      assert.fail('the dead port answered, so this test proves nothing');
    } catch (err) {
      caught = err;
      said = describeFetchFailure(err, { method: 'POST', url, elapsedMs: Date.now() - startedAt });
    }

    assert.match(said, /POST http:\/\/127\.0\.0\.1:\d+\/api\/session/);
    assert.match(said, /after \d+ms/);
    assert.match(said, /ECONNREFUSED/, `the cause never reached the message: ${said}`);
    // And the thing the original string could not do: tell this apart from a timeout.
    assert.doesNotMatch(said, /^fetch failed$/);
    assert.equal(isNetworkError(caught), true);
  });
});
