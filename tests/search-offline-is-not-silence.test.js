import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runMemorySearch } from '../mcp/lib/memory-search.js';
import { classifySearchLegs } from '../mcp/lib/search-legs.js';
import { formatCacheAge, makeOfflineHelpers } from '../mcp/offline.js';

/**
 * #129 — a search that cannot reach the server must not answer "0 hits".
 *
 * 2026-09-14: an MCP process kept a session open across a laptop sleep and every request it
 * made afterwards failed with `fetch failed`. Writes said so. Search did not: both of its
 * API calls carried `.catch(() => [])`, so the handler's catch block — the one holding the
 * offline fallback and its notice — never ran. `ownmind_search('legacy host ENCRYPTION_KEY')`
 * returned `memory_total: 0` while that memory sat on the server, and the caller had nothing
 * in the response to tell it apart from "you never saved this".
 *
 * The rule this breaks is IR-111: a zero with no control is not a conclusion.
 */

const netErr = () => new Error('fetch failed');
const apiErr = (msg = 'API 500: server error') => new Error(msg);
const { isNetworkError, localSearch } = makeOfflineHelpers();

/** A cache holding one memory, so an offline search has something real to find. */
const CACHE = {
  saved_at: '2026-09-14T02:00:00.000Z',
  data: {
    project: [{ id: 745, type: 'project', title: 'legacy-server.example production host', content: 'ENCRYPTION_KEY lives in /srv/ownmind/.env', tags: ['legacy host'] }],
  },
};

const deps = (overrides = {}) => ({
  callApi: async () => { throw netErr(); },
  isNetworkError,
  readMemoryCache: () => CACHE,
  localSearch,
  formatCacheAge,
  logEvent: () => {},
  ...overrides,
});

describe('#129 — the network is down', () => {
  it('answers from the cache instead of reporting zero', async () => {
    const res = await runMemorySearch(deps(), { query: 'legacy host' });
    assert.equal(res._offline, true, 'the response must say it came from the cache');
    assert.equal(res.memory_total, 1, 'the cached memory must be found');
  });

  it('every zero-hit response carries a notice — a bare zero is the bug', async () => {
    const res = await runMemorySearch(deps(), { query: 'nothing-matches-this' });
    assert.equal(res.memory_total, 0);
    assert.equal(res._offline, true);
    assert.match(res._offline_notice, /not evidence that nothing is stored/);
  });

  it('the notice says how old the cache is and how to get back online', async () => {
    const res = await runMemorySearch(deps(), { query: 'legacy host' });
    assert.match(res._offline_notice, /2026-09-14T02:00:00\.000Z/, 'must name the cache timestamp');
    assert.match(res._offline_notice, /old/, 'must say how far behind the cache is');
    assert.match(res._offline_notice, /start a new session/i, 'must say what fixes it');
  });

  it('a missing cache still reports offline rather than zero without explanation', async () => {
    const res = await runMemorySearch(deps({ readMemoryCache: () => null }), { query: 'legacy host' });
    assert.equal(res._offline, true);
    assert.equal(res.memory_total, 0);
    assert.match(res._offline_notice, /age unknown/);
  });
});

describe('#129 — one half of the search fails', () => {
  const legFails = (failingPath, error) => async (method, path) => {
    if (path.startsWith(failingPath)) throw error;
    return path.startsWith('/api/memory') ? { data: [{ id: 1, title: 'hit' }], total: 1, returned: 1 } : [];
  };

  it('session logs unreachable → results come back marked partial', async () => {
    const res = await runMemorySearch(deps({ callApi: legFails('/api/session', apiErr()) }), { query: 'x' });
    assert.equal(res._partial, true);
    assert.equal(res.memory_hits, 1, 'the half that answered must still be returned');
    assert.match(res._partial_notice, /session logs/);
    assert.match(res._partial_notice, /nothing is stored/);
  });

  it('memories unreachable for a non-network reason → partial, not a silent zero', async () => {
    const res = await runMemorySearch(deps({ callApi: legFails('/api/memory', apiErr()) }), { query: 'x' });
    assert.equal(res._partial, true);
    assert.equal(res.memory_total, 0);
    assert.match(res._partial_notice, /saved memories/);
  });

  it('both halves fail for a non-network reason → the caller sees the error', async () => {
    await assert.rejects(
      () => runMemorySearch(deps({ callApi: async () => { throw apiErr('API 500: boom'); } }), { query: 'x' }),
      /API 500: boom/,
      'an unexplained failure must reach the caller, not be flattened to zero results',
    );
  });
});

describe('#129 — nothing failed', () => {
  it('a normal search carries no offline or partial marker', async () => {
    const callApi = async (method, path) => (path.startsWith('/api/memory')
      ? { data: [{ id: 9, title: 'real hit' }], total: 1, returned: 1 }
      : [{ id: 3, summary: 'a session log' }]);
    const res = await runMemorySearch(deps({ callApi }), { query: 'x' });
    assert.equal(res._offline, undefined);
    assert.equal(res._partial, undefined);
    assert.equal(res.memory_hits, 1);
    assert.equal(res.session_hits, 1);
    assert.equal(res.data.length, 2);
  });

  it('a refreshed sync token is handed back for the caller to keep', async () => {
    const callApi = async (method, path) => (path.startsWith('/api/memory')
      ? { data: [], total: 0, returned: 0, new_token: 'tok-2' }
      : []);
    const res = await runMemorySearch(deps({ callApi }), { query: 'x', syncToken: 'tok-1' });
    assert.equal(res._new_token, 'tok-2');
  });

  it('the sync token is sent with the memory search', async () => {
    let seen = null;
    const callApi = async (method, path) => { if (path.startsWith('/api/memory')) seen = path; return []; };
    await runMemorySearch(deps({ callApi }), { query: 'x', syncToken: 'tok-1' });
    assert.match(seen, /sync_token=tok-1/);
  });
});

describe('classifySearchLegs', () => {
  const ok = { ok: true, value: [] };
  it('both answered → online', () => {
    assert.equal(classifySearchLegs({ memory: ok, session: ok }, isNetworkError).mode, 'online');
  });
  it('memory half hit a network error → offline', () => {
    const v = classifySearchLegs({ memory: { ok: false, error: netErr() }, session: ok }, isNetworkError);
    assert.equal(v.mode, 'offline');
  });
  it('one half failed for another reason → partial, with the reason in the notice', () => {
    const v = classifySearchLegs({ memory: ok, session: { ok: false, error: apiErr('API 503: down') } }, isNetworkError);
    assert.equal(v.mode, 'partial');
    assert.match(v.notice, /API 503: down/);
  });
  it('both halves failed for another reason → error, carrying the error from the memories half', () => {
    const boom = apiErr('API 500: boom');
    const v = classifySearchLegs({ memory: { ok: false, error: boom }, session: { ok: false, error: apiErr() } }, isNetworkError);
    assert.equal(v.mode, 'error');
    assert.equal(v.error, boom);
  });
});

describe('formatCacheAge', () => {
  const base = Date.parse('2026-09-14T08:00:00.000Z');
  it('no timestamp → says the age is unknown', () => {
    assert.equal(formatCacheAge(undefined, base), 'age unknown');
    assert.equal(formatCacheAge('not a date', base), 'age unknown');
  });
  it('minutes, hours and days each read as themselves', () => {
    assert.match(formatCacheAge('2026-09-14T07:59:00.000Z', base), /1 minute old/);
    assert.match(formatCacheAge('2026-09-14T05:00:00.000Z', base), /3 hours old/);
    assert.match(formatCacheAge('2026-09-10T08:00:00.000Z', base), /4 days old/);
  });
  it('a cache stamped in the future is not described as fresh', () => {
    assert.match(formatCacheAge('2026-09-15T08:00:00.000Z', base), /age unknown/);
  });
});
