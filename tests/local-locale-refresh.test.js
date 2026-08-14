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

  it('cache_fresh counts as success: the cache already carries the new locale, nothing to fetch', async () => {
    // The success condition accepts `cache_fresh` as well as `init_refreshed`, and this pins
    // why. `ok` claims "the local cache reflects the server's current state"; a matching
    // sync_token says exactly that. It happens when another process synced in the window
    // after the PUT, or when the PUT re-selected the locale the account already had. Reporting
    // failure here would tell the user the change had not taken effect on a machine where it
    // demonstrably had.
    const tmpHome = tempDir('ownmind-local-locale-refresh-fresh-');
    const cachePath = path.join(tmpHome, '.ownmind', 'cache', 'memories.json');
    const account = { apiUrl: 'http://api', apiKey: 'K' };

    writeCache(
      { sync_token: 'CURRENT', data: { sync_token: 'CURRENT', iron_rules_digest: '', locale: 'ja' } },
      cachePath,
      undefined,
      account,
    );

    const fetchFn = makeFetch([
      ['sync-token', () => okJson({ sync_token: 'CURRENT' })],
      ['init', () => { throw new Error('init must not be called when the token already matches'); }],
    ]);

    const result = await refreshLocalCacheForLocale({ ...account, cachePath, fetchFn });

    assert.equal(result.source, 'cache_fresh');
    assert.equal(result.ok, true, 'a cache that already matches the server is a success, not a failure');
    assert.equal(getLocale({ homeDir: tmpHome }), 'ja');
  });

  /**
   * Fix round 2 — the cache on disk may not belong to the account this MCP is configured
   * with, and rewriting it destroys the other account's whole init payload.
   *
   * The MCP resolves its credentials from `process.env` only (mcp/index.js). The hooks
   * resolve theirs files-first, env-last (scripts/install-helpers/resolve-credentials.cjs:
   * ~/.claude/settings.json -> settings.local.json -> .claude.json -> env). On a machine
   * running more than one OwnMind account those two can differ, and `cache/memories.json`
   * has exactly one owner: the hooks.
   *
   * Without a guard, `runConditionalSync` under account A finds a cache stamped B, refuses
   * to *read* it (v1.26.82) — and then downloads A's init and writes it over the top, which
   * is the destructive half that check never covered. B's profile, iron rules and digests
   * are gone; `getLocale` has no fingerprint check at all, so it then serves A's language on
   * a machine whose hooks are B; and at B's next SessionStart `readCache` correctly refuses
   * the A-stamped file, so an offline session loads no memories at all — strictly worse than
   * the `cache_fallback` it would have had.
   */
  it('a cache stamped with another account is left byte-for-byte alone (no sync, not ok)', async () => {
    const tmpHome = tempDir('ownmind-local-locale-refresh-other-account-');
    const cachePath = path.join(tmpHome, '.ownmind', 'cache', 'memories.json');
    const hooksAccount = { apiUrl: 'http://api', apiKey: 'HOOKS-KEY-B' };
    const mcpAccount = { apiUrl: 'http://api', apiKey: 'MCP-KEY-A' };

    // What the hooks left behind: account B's whole init payload.
    writeCache(
      {
        sync_token: 'B-TOKEN',
        data: { sync_token: 'B-TOKEN', iron_rules_digest: 'B-DIGEST', locale: 'zh', profile: { name: 'B' } },
      },
      cachePath,
      undefined,
      hooksAccount,
    );
    const before = fs.readFileSync(cachePath, 'utf8');

    // A fetch that would happily succeed — so nothing but the guard can prevent the write.
    const fetchFn = makeFetch([
      ['sync-token', () => okJson({ sync_token: 'A-TOKEN' })],
      ['init', () => okJson({
        sync_token: 'A-TOKEN', server_version: '9.9.9', iron_rules_digest: 'A-DIGEST', locale: 'ja',
      })],
    ]);

    const result = await refreshLocalCacheForLocale({ ...mcpAccount, cachePath, fetchFn });

    assert.equal(result.ok, false, 'refreshing another account\'s cache must never be reported as success');
    assert.equal(result.source, 'account_mismatch');
    assert.equal(fs.readFileSync(cachePath, 'utf8'), before,
      "the other account's cache must be byte-for-byte untouched");
  });

  it('a cache stamped with this same account still refreshes as before', async () => {
    const tmpHome = tempDir('ownmind-local-locale-refresh-same-account-');
    const cachePath = path.join(tmpHome, '.ownmind', 'cache', 'memories.json');
    const account = { apiUrl: 'http://api', apiKey: 'SAME-KEY' };

    writeCache(
      { sync_token: 'OLD', data: { sync_token: 'OLD', iron_rules_digest: '', locale: 'zh' } },
      cachePath,
      undefined,
      account,
    );

    const fetchFn = makeFetch([
      ['sync-token', () => okJson({ sync_token: 'NEW' })],
      ['init', () => okJson({
        sync_token: 'NEW', server_version: '9.9.9', iron_rules_digest: '', locale: 'ja',
      })],
    ]);

    const result = await refreshLocalCacheForLocale({ ...account, cachePath, fetchFn });

    assert.equal(result.ok, true, 'the guard must only fire for a *different* account');
    assert.equal(result.source, 'init_refreshed');
    assert.equal(getLocale({ homeDir: tmpHome }), 'ja');
  });

  it('no cache file at all refreshes normally — there is nothing to clobber', async () => {
    const tmpHome = tempDir('ownmind-local-locale-refresh-no-cache-');
    const cachePath = path.join(tmpHome, '.ownmind', 'cache', 'memories.json');
    assert.equal(fs.existsSync(cachePath), false, 'precondition: a staged home with no cache yet');

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
    assert.equal(getLocale({ homeDir: tmpHome }), 'ja');
  });

  it('a cache with no account stamp at all is still refreshed (it is unreadable to everyone)', async () => {
    // Pre-v1.26.82 caches carry no `account` field. `readCache` already refuses those for
    // *every* account, so the file is dead weight to whoever holds it — overwriting it
    // destroys nothing anyone could have read, and is exactly what a normal SessionStart
    // does. Only a *differing* stamp means a live cache belonging to somebody else.
    const tmpHome = tempDir('ownmind-local-locale-refresh-unstamped-');
    const cachePath = path.join(tmpHome, '.ownmind', 'cache', 'memories.json');

    writeCache(
      { sync_token: 'OLD', data: { sync_token: 'OLD', iron_rules_digest: '', locale: 'zh' } },
      cachePath,
    );
    assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).account, undefined,
      'precondition: an unstamped, legacy-shaped cache');

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

describe('cache path ownership', () => {
  it('imports the cache path instead of restating it', async () => {
    // The guard reads the cache before handing it over, so it must look at the file
    // conditional-sync.js actually writes. A private second literal here would let the guard
    // drift off the real cache in silence if the path ever moved, disarming the cross-account
    // protection while every test stayed green.
    const sync = await import('../hooks/lib/conditional-sync.js');
    assert.equal(typeof sync.DEFAULT_CACHE_PATH, 'string');
    const src = fs.readFileSync(new URL('../mcp/lib/local-locale-refresh.js', import.meta.url), 'utf8');
    assert.ok(
      /import\s*\{[^}]*DEFAULT_CACHE_PATH[^}]*\}\s*from\s*'\.\.\/\.\.\/hooks\/lib\/conditional-sync\.js'/.test(src),
      'local-locale-refresh.js must import DEFAULT_CACHE_PATH from conditional-sync.js',
    );
    assert.ok(
      !/['"]memories\.json['"]/.test(src.replace(/^\s*\*.*$/gm, '')),
      'local-locale-refresh.js must not restate the cache filename outside comments',
    );
  });
});
