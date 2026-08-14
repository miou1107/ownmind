import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { refreshLocalCacheForLocale } from '../mcp/lib/local-locale-refresh.js';
import { writeCache } from '../hooks/lib/conditional-sync.js';
import { getLocale } from '../hooks/lib/locale.js';
import { tempDir } from './helpers/temp-dir.js';

/**
 * Task 5 fix round 1 (gate-message-i18n) — immediate local propagation.
 *
 * The sync-token fix makes the account's locale part of the token, so the existing
 * conditional-sync client re-inits on its own — but only at the machine's *next* session
 * start. This covers the machine that actually calls `ownmind_set_locale`, which must not
 * wait: `refreshLocalCacheForLocale` reuses `runConditionalSync` (the exact function
 * `hooks/lib/conditional-sync.js` already owns) to refresh `cache/memories.json` right away,
 * so this machine's very next hook invocation already resolves the new language via
 * `hooks/lib/locale.js`'s `getLocale()`.
 */

function makeFetch(handlers) {
  return async (url) => {
    for (const [pattern, handler] of handlers) {
      if (url.includes(pattern)) return handler();
    }
    throw new Error(`unmocked: ${url}`);
  };
}

function okJson(body) {
  return { ok: true, status: 200, json: async () => body };
}

function failRequest() {
  throw new Error('network unreachable');
}

describe('refreshLocalCacheForLocale', () => {
  it('a pinned locale (zh -> ja) reaches cache.data.locale, and getLocale() returns it', async () => {
    const tmpHome = tempDir('ownmind-local-locale-refresh-');
    const cachePath = path.join(tmpHome, '.ownmind', 'cache', 'memories.json');

    // A machine that already synced once, before the account's locale changed.
    writeCache(
      { sync_token: 'OLD', data: { sync_token: 'OLD', iron_rules_digest: '', locale: 'zh' } },
      cachePath,
    );

    const fetchFn = makeFetch([
      ['sync-token', () => okJson({ sync_token: 'NEW' })],
      ['init', () => okJson({
        sync_token: 'NEW', server_version: '9.9.9', iron_rules_digest: '', locale: 'ja',
      })],
    ]);

    const result = await refreshLocalCacheForLocale({
      apiUrl: 'http://api', apiKey: 'K', cachePath, fetchFn,
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'init_refreshed');

    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(cache.data.locale, 'ja');
    assert.equal(getLocale({ homeDir: tmpHome }), 'ja',
      'the hook-facing locale resolver must see the refreshed cache immediately');
  });

  it('auto (clear) removes the value from cache.data, and getLocale() stops returning the stale one', async () => {
    const tmpHome = tempDir('ownmind-local-locale-refresh-auto-');
    const cachePath = path.join(tmpHome, '.ownmind', 'cache', 'memories.json');

    writeCache(
      { sync_token: 'OLD', data: { sync_token: 'OLD', iron_rules_digest: '', locale: 'zh' } },
      cachePath,
    );

    const fetchFn = makeFetch([
      ['sync-token', () => okJson({ sync_token: 'NEW' })],
      // The server's GET /init sends `locale: null` once the account clears the preference
      // (auto) — src/routes/memory.js: `locale: accountLocale || null`.
      ['init', () => okJson({
        sync_token: 'NEW', server_version: '9.9.9', iron_rules_digest: '', locale: null,
      })],
    ]);

    const result = await refreshLocalCacheForLocale({
      apiUrl: 'http://api', apiKey: 'K', cachePath, fetchFn,
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'init_refreshed');

    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(cache.data.locale, null);
    const resolved = getLocale({ homeDir: tmpHome });
    assert.notEqual(resolved, 'zh', 'the stale pinned value must not survive an auto-clear refresh');
    assert.equal(resolved, 'en', 'no OS-detected state file in this staged home, so the final fallback applies');
  });

  it('a fetch failure degrades gracefully: ok:false, no throw, existing cache left untouched', async () => {
    const tmpHome = tempDir('ownmind-local-locale-refresh-fail-');
    const cachePath = path.join(tmpHome, '.ownmind', 'cache', 'memories.json');

    writeCache(
      { sync_token: 'OLD', data: { sync_token: 'OLD', iron_rules_digest: '', locale: 'zh' } },
      cachePath,
    );
    const before = fs.readFileSync(cachePath, 'utf8');

    const result = await refreshLocalCacheForLocale({
      apiUrl: 'http://api', apiKey: 'K', cachePath, fetchFn: failRequest,
    });

    assert.equal(result.ok, false);
    const after = fs.readFileSync(cachePath, 'utf8');
    assert.equal(after, before, 'a failed refresh must not corrupt or partially overwrite the existing cache');
  });
});
