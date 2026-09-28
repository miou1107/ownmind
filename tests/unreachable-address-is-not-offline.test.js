/**
 * A host name that never resolves is a setting that is wrong, not a server that is down.
 *
 * 2026-09-28: `ownmind_search` answered "could not reach the OwnMind server (tried twice)"
 * and served a 43-day-old cache, while curl against the configured URL returned 200 from the
 * same machine in the same second. Eight memory writes had piled up in the offline queue over
 * five days, the oldest from 2026-08-23.
 *
 * The MCP process was dialling `https://YOUR_OWNMIND_URL/ownmind` — the placeholder the
 * installer ships, never substituted. Every request died at DNS with `ENOTFOUND` in about
 * 60ms. `ENOTFOUND` is in NETWORK_CODES, so `isNetworkError` said yes, so offline mode
 * engaged and said the server was unreachable. It was not: nothing had ever dialled it.
 *
 * The notice made it worse by naming the wrong remedy — "only a new session restores it" —
 * when a new session inherits the same wrong address and fails identically. The address the
 * tool is dialling is the one fact that separates the two cases, and it was never printed.
 *
 * Offline mode itself stays: a cache is still the right answer while the tool cannot reach
 * the server. What changes is what the caller is told to go and fix.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addressFault } from '../mcp/lib/fetch-failure.js';
import { runMemorySearch } from '../mcp/lib/memory-search.js';
import { formatCacheAge, makeOfflineHelpers } from '../mcp/offline.js';

const { isNetworkError, localSearch } = makeOfflineHelpers();

/** An error shaped the way undici rejects: a bare outer message, the fault on `cause`. */
function undiciStyle(code, message = 'connect failed') {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
}

const PLACEHOLDER = 'https://YOUR_OWNMIND_URL/ownmind';
const REAL = 'https://ownmind.example.com/ownmind';

const CACHE = {
  saved_at: '2026-08-15T15:00:20.736Z',
  data: {
    env: [{ id: 1310, type: 'env', title: 'the company host needs the VPN', content: 'port 22 only answers on the VPN', tags: ['vpn'] }],
  },
};

const deps = (overrides = {}) => ({
  callApi: async () => { throw undiciStyle('ENOTFOUND', 'getaddrinfo ENOTFOUND YOUR_OWNMIND_URL'); },
  isNetworkError,
  readMemoryCache: () => CACHE,
  localSearch,
  formatCacheAge,
  logEvent: () => {},
  apiUrl: PLACEHOLDER,
  ...overrides,
});

describe('addressFault — which failures are the address, not the network', () => {
  it('names the address when the host does not resolve', () => {
    const fault = addressFault(undiciStyle('ENOTFOUND'), REAL);
    assert.ok(fault, 'an unresolvable host must produce a fault line');
    assert.ok(fault.includes(REAL), `the address must be printed, got: ${fault}`);
  });

  it('says a running tool keeps the address it started with, so it has to be restarted', () => {
    const fault = addressFault(undiciStyle('ENOTFOUND'), REAL);
    assert.match(fault, /restart/i, `the remedy must be to restart the tool, got: ${fault}`);
  });

  it('calls the installer placeholder what it is', () => {
    const fault = addressFault(undiciStyle('ENOTFOUND'), PLACEHOLDER);
    assert.match(fault, /placeholder/i, `a never-substituted address must be named, got: ${fault}`);
  });

  it('a DNS lookup that is merely slow to answer counts too', () => {
    assert.ok(addressFault(undiciStyle('EAI_AGAIN'), REAL), 'EAI_AGAIN is the same class of fault');
  });

  it('stays quiet for a genuine network fault — a reset connection reached a real host', () => {
    assert.equal(addressFault(undiciStyle('ECONNRESET'), REAL), '', 'ECONNRESET is not an address problem');
    assert.equal(addressFault(undiciStyle('UND_ERR_CONNECT_TIMEOUT'), REAL), '', 'a connect timeout is not an address problem');
  });

  it('stays quiet when nothing tells it which address was dialled', () => {
    assert.equal(addressFault(undiciStyle('ENOTFOUND'), ''), '', 'without the address there is nothing to report');
  });
});

describe('the search notice when the configured address is the fault', () => {
  it('still answers from the cache — the caller keeps what it can have', async () => {
    const res = await runMemorySearch(deps(), { query: 'vpn' });
    assert.equal(res._offline, true, 'the response must still say it came from the cache');
    assert.equal(res.memory_total, 1, 'the cached memory must still be found');
  });

  it('prints the address it dialled', async () => {
    const res = await runMemorySearch(deps(), { query: 'vpn' });
    assert.ok(
      res._offline_notice.includes(PLACEHOLDER),
      `the notice must name the address, got: ${res._offline_notice}`,
    );
  });

  it('does not blame the server or promise that a new session fixes it', async () => {
    const res = await runMemorySearch(deps(), { query: 'vpn' });
    assert.doesNotMatch(
      res._offline_notice,
      /could not reach the OwnMind server/i,
      'a name that never resolved did not fail to reach the server',
    );
    assert.doesNotMatch(
      res._offline_notice,
      /only a new session restores it/i,
      'a new session inherits the same wrong address',
    );
  });

  it('leaves the ordinary offline notice alone when the network really is down', async () => {
    const res = await runMemorySearch(
      deps({
        callApi: async () => { throw undiciStyle('ECONNRESET', 'socket hang up'); },
        apiUrl: REAL,
      }),
      { query: 'vpn' },
    );
    assert.match(
      res._offline_notice,
      /could not reach the OwnMind server/i,
      'a reset connection is still the offline case',
    );
  });
});
