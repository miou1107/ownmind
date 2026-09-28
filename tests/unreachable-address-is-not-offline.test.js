/**
 * A host name that never resolves is a setting that may be wrong, not a server that is down.
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
 * the server. What changes is what the caller is told to go and fix — and, on the write path,
 * whether they are told their queued memory will ever be sent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addressFault } from '../mcp/lib/fetch-failure.js';
import { makeNoticeHelpers } from '../mcp/lib/offline-notices.js';
import { runMemorySearch } from '../mcp/lib/memory-search.js';
import { formatCacheAge, makeOfflineHelpers } from '../mcp/offline.js';

const { isNetworkError, localSearch } = makeOfflineHelpers();

/** An error shaped the way undici rejects: a bare outer message, the fault on `cause`. */
function undiciStyle(code, message = 'connect failed') {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
}

const PLACEHOLDER = 'https://YOUR_OWNMIND_URL/ownmind';
const REAL = 'https://ownmind.example.com/ownmind';
const DEFAULT_URL = 'http://localhost:3100';

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
    const { line } = addressFault(undiciStyle('ENOTFOUND'), REAL);
    assert.ok(line, 'an unresolvable host must produce a fault line');
    assert.ok(line.includes(REAL), `the address must be printed, got: ${line}`);
  });

  it('says a running tool keeps the address it started with, so it has to be restarted', () => {
    const { line } = addressFault(undiciStyle('ENOTFOUND'), REAL);
    assert.match(line, /restart/i, `the remedy must be to restart the tool, got: ${line}`);
  });

  it('calls the installer placeholder what it is', () => {
    const { line, kind } = addressFault(undiciStyle('ENOTFOUND'), PLACEHOLDER);
    assert.equal(kind, 'placeholder');
    assert.match(line, /placeholder/i, `a never-substituted address must be named, got: ${line}`);
  });

  // The install instructions people copy from write it without a scheme, and `new URL`
  // refuses that form — so the one host that most needs naming went unnamed.
  it('recognises the placeholder written the way the instructions write it, with no scheme', () => {
    assert.equal(addressFault(undiciStyle('ENOTFOUND'), 'YOUR_OWNMIND_URL/ownmind').kind, 'placeholder');
  });

  it('a DNS lookup that is merely slow to answer counts too', () => {
    assert.equal(addressFault(undiciStyle('EAI_AGAIN'), REAL).kind, 'unresolved');
  });

  it('stays quiet for a genuine network fault — a reset connection reached a real host', () => {
    assert.equal(addressFault(undiciStyle('ECONNRESET'), REAL).line, '', 'ECONNRESET is not an address problem');
    assert.equal(addressFault(undiciStyle('UND_ERR_CONNECT_TIMEOUT'), REAL).line, '', 'a connect timeout is not an address problem');
  });

  it('stays quiet when nothing tells it which address was dialled', () => {
    assert.equal(addressFault(undiciStyle('ENOTFOUND'), '').line, '', 'without the address there is nothing to report');
  });
});

describe('addressFault — the two readings it must not confuse', () => {
  // Review of this change: ENOTFOUND is also what a laptop with the Wi-Fi off returns, and
  // EAI_AGAIN is literally a temporary resolver failure. Telling that person "this is the
  // setting, not your connection" is the same confident wrong diagnosis, on a much larger
  // population than "never substituted the placeholder".
  it('does not call a resolvable-looking address a placeholder', () => {
    const { line } = addressFault(undiciStyle('ENOTFOUND'), REAL);
    assert.doesNotMatch(line, /placeholder/i, `a real address is not a placeholder, got: ${line}`);
  });

  it('leaves the network on the table when the address may well be right', () => {
    const { line } = addressFault(undiciStyle('ENOTFOUND'), REAL);
    assert.match(line, /cannot look up names|connection/i, `both readings must be offered, got: ${line}`);
    assert.doesNotMatch(line, /not the server and not your connection/i, 'it cannot rule the connection out');
  });

  // A customer host under a domain the installer happens to use as an example: substring
  // matching told a self-hoster mid-outage that their working server was never configured.
  it('a real host that merely contains the example domain is not a placeholder', () => {
    const { line } = addressFault(undiciStyle('ECONNRESET'), 'https://mem.your-server.com/ownmind');
    assert.equal(line, '', `a reset connection to a customer host is not a setup problem, got: ${line}`);
  });

  it('the placeholder is called out however the connection failed', () => {
    assert.match(addressFault(undiciStyle('ECONNRESET'), PLACEHOLDER).line, /placeholder/i);
  });

  it('names the built-in default when nobody set the address at all', () => {
    const { line, kind } = addressFault(undiciStyle('ECONNREFUSED'), DEFAULT_URL, { configured: false });
    assert.equal(kind, 'unset');
    assert.match(line, /built-in default/i, `an unset address must be named, got: ${line}`);
    assert.equal(
      addressFault(undiciStyle('ECONNREFUSED'), DEFAULT_URL).line,
      '',
      'a localhost address somebody chose on purpose is not a setup problem',
    );
  });

  // The project's own compose file publishes the API on 3100, so a self-hoster who never set
  // the variable is correctly pointed at their own server and is looking at an outage. The
  // first draft told exactly those people "there is no server there".
  it('does not tell a self-hoster on the default port that nothing is running there', () => {
    const { line } = addressFault(undiciStyle('ECONNREFUSED'), DEFAULT_URL, { configured: false });
    assert.doesNotMatch(line, /there is no server there/i, `an outage on the default port is not proof of a wrong setting, got: ${line}`);
    assert.match(line, /not up right now|on this machine/i, `the outage reading must be offered, got: ${line}`);
  });

  // v1.30.21 shipped a guard that passed while checking a shape production never produces.
  // `callApi` wraps undici's rejection once more, so the chain that reaches here is three
  // links deep, not two. The placeholder branch answers before the code is ever read, so
  // this has to run against an address that reaches the code-reading branch.
  it('reads the code through the wrapper callApi actually throws', () => {
    const undici = undiciStyle('ENOTFOUND', 'getaddrinfo ENOTFOUND ownmind.example.com');
    const asThrown = new Error('fetch failed — GET https://…/api/memory/search after 61ms', { cause: undici });
    assert.equal(addressFault(asThrown, REAL).kind, 'unresolved', 'the real chain must still be read');
    assert.equal(
      addressFault(new Error('fetch failed — GET … after 61ms', { cause: undiciStyle('ECONNRESET') }), REAL).kind,
      '',
      'and a three-link chain carrying a reset must still read as an ordinary outage',
    );
  });
});

describe('what a queued write is promised', () => {
  const notice = (url, configured, code, pending = 8) =>
    makeNoticeHelpers({ apiUrl: url, apiUrlConfigured: configured }).queueNotice(undiciStyle(code), pending);

  it('says outright that a placeholder will never send it', () => {
    const msg = notice(PLACEHOLDER, true, 'ENOTFOUND');
    assert.match(msg, /nothing will send it until the address is fixed/i, `got: ${msg}`);
    assert.doesNotMatch(msg, /once back online/i, 'the machine was online the whole five weeks');
    assert.ok(msg.includes('8 pending'), 'the caller must be told how much is waiting');
  });

  // The defect this branch exists to fix, pointed the other way. A dropped VPN is far more
  // common than a wrong setting, that queue really does flush by itself, and sending the
  // person to edit a correct setting is the same confident wrong diagnosis.
  it('does not tell a person on a dropped VPN that their memory is stuck until they edit a setting', () => {
    const msg = notice(REAL, true, 'ENOTFOUND');
    assert.doesNotMatch(msg, /nothing will send it until the address is fixed/i, `got: ${msg}`);
    assert.match(msg, /when this tool reaches that address/i, `the queue does flush when the connection returns, got: ${msg}`);
    assert.ok(msg.includes(REAL), 'and the address is still printed, so a wrong one can be spotted');
  });

  // An unset address has two outcomes, not one: starting the local server sends the queue,
  // a server that lives somewhere else never will. The notice may not promise either.
  it('treats an unset address the same way, and promises neither outcome', () => {
    const msg = notice(DEFAULT_URL, false, 'ECONNREFUSED', 1);
    assert.doesNotMatch(msg, /nothing will send it until the address is fixed/i, `got: ${msg}`);
    assert.match(msg, /when this tool reaches that address, and not before/i, `got: ${msg}`);
    assert.doesNotMatch(msg, /will be sent automatically/i, 'nothing here is automatic');
  });

  it('leaves the ordinary queue notice alone when the address is not in question', () => {
    const msg = notice(REAL, true, 'ECONNRESET', 1);
    assert.match(msg, /will be sent automatically once back online/i, `got: ${msg}`);
    assert.doesNotMatch(msg, /address/i, 'nothing here points at the address');
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

  // "Until it is fixed" asserts there is something to fix. Against an address that merely did
  // not resolve this minute, there may be nothing wrong with it at all.
  it('does not assert there is a setting to fix when the address may be fine', async () => {
    const res = await runMemorySearch(deps({
      callApi: async () => { throw undiciStyle('ENOTFOUND', 'getaddrinfo ENOTFOUND ownmind.example.com'); },
      apiUrl: REAL,
    }), { query: 'vpn' });
    assert.doesNotMatch(res._offline_notice, /until it is fixed/i, `got: ${res._offline_notice}`);
    assert.ok(res._offline_notice.includes(REAL), 'the address is still printed');
    assert.doesNotMatch(res._offline_notice, /only a new session restores it/i, 'the next call resolves again once the connection is back');
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
    assert.match(res._offline_notice, /only a new session restores it/i, 'and it keeps its own closing advice');
  });
});

// Every place that says "offline" is a place somebody decides whether to wait or go and fix
// something, and the address is what tells those apart. The session_log notice shipped
// without it in the first draft of this change, so this is a guard rather than a preference.
describe('every offline notice in the MCP server carries the address line', () => {
  it('has faultPrefix in front of each one', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const lines = fs.readFileSync(path.join(here, '..', 'mcp', 'index.js'), 'utf8').split('\n');
    const missing = [];
    lines.forEach((line, i) => {
      if (!line.includes('[OwnMind offline mode]')) return;
      const window = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
      if (!window.includes('faultPrefix(')) missing.push(`${i + 1}: ${line.trim().slice(0, 80)}`);
    });
    assert.deepEqual(missing, [], `these notices never name the address:\n${missing.join('\n')}`);
  });
});
