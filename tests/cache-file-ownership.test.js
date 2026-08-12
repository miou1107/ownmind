/**
 * v1.26.138 — the SessionStart memory load rendered nothing, and said it was fine.
 *
 * Two programs kept a cache at `~/.ownmind/cache/memories.json`, in two incompatible shapes:
 *
 *   hooks/lib/conditional-sync.js  { sync_token, saved_at, account, data: <init response> }
 *   mcp/offline.js                 { sync_token, saved_at, account, data: { profile: [...],
 *                                                                          iron_rule: [...], … } }
 *
 * Step 2 of runConditionalSync returns `cache.data` as the init payload whenever the cached
 * sync_token matches the server's. So after any MCP init, renderSessionContext was handed the
 * type-keyed object and read `.profile` / `.iron_rules_digest` off it — producing a banner
 * with no version, no iron rules and no profile. The hook logged `init: ok`, wrote nothing to
 * stderr, and exited 0. Measured on Windows 2026-08-10 immediately after updating to 1.26.137:
 *
 *     [OwnMind v?] Memory loaded: your personal memories are now active
 *     ## Profile
 *     - :
 *
 * What had hidden it until v1.26.133 was an accident. The MCP wrote no `account` field, so
 * readCache refused the file under the v1.26.82 rule that an unattributed cache belongs to
 * somebody else, and the hook quietly fell through to a full download. Stamping the MCP's
 * cache — correct in itself — removed that protection and turned a latent schema collision
 * into a memory load that contained nothing.
 *
 * Two fixes, and both are asserted here, because either alone leaves a way back:
 *   1. the MCP has its own file, so the two no longer share a path
 *   2. readCache refuses a payload shaped for the other consumer, so a machine whose file is
 *      already wrong heals on its next session instead of needing a manual delete
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCache, holdsInitPayload } from '../hooks/lib/conditional-sync.js';
import { accountFingerprint } from '../shared/scanners/base.js';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
  .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** What the MCP writes: one array per memory type. */
const MCP_SHAPE = {
  profile: [{ id: 790 }],
  principle: [{ id: 853 }],
  iron_rule: [{ id: 854, code: 'IR-004' }],
  coding_standard: [],
  team_standard: [],
  project: [],
  env: [],
  portfolio: [],
};

/** What the hook writes: the init response, verbatim. */
const INIT_SHAPE = {
  compact: true,
  server_version: '1.26.137',
  profile: { id: 790, title: 'who this account is' },
  principles: [{ id: 853, title: 'push straight to main' }],
  iron_rules_digest: 'IR-004: reply in plain language',
  iron_rules_count: 4,
};

describe('the two caches do not share a file', () => {
  it('the MCP writes only its own file', () => {
    const src = code('mcp/offline.js');
    assert.match(src, /cache\/mcp-memories\.json/, 'the MCP has no cache path of its own');

    // v1.26.148 the MCP reads the hook's file — Claude Code never calls ownmind_init, so the
    // askable-standards list only reaches the per-response tip from there. Reading is safe;
    // what caused v1.26.137's silent empty banner was two writers on one file. So the
    // constraint is now on the direction, not on the mention: the hook path may appear, and
    // it may not be what writeMemoryCache writes.
    assert.match(src, /const DEFAULT_HOOK_CACHE_PATH[^\n]*cache\/memories\.json/,
      'the hook path must be named once, as its own constant');
    const writer = src.slice(src.indexOf('function writeMemoryCache'), src.indexOf('function localSearch'));
    assert.doesNotMatch(writer, /hookCachePath/, 'the MCP must never write the hook\'s cache');
    assert.match(src, /function readHookInitPayload/);
  });

  it('the hook still owns memories.json', () => {
    // Reverse control: if this moved too, the assertion above would pass while both writers
    // had simply followed each other to a new shared path.
    assert.match(code('hooks/lib/conditional-sync.js'), /cache', 'memories\.json/,
      'the hook cache path moved; check the two are still different files');
  });
});

describe('holdsInitPayload', () => {
  it('accepts an init response', () => {
    assert.equal(holdsInitPayload({ data: INIT_SHAPE }), true);
  });

  it('refuses the MCP\'s type-keyed cache — the regression', () => {
    // This is the whole defect. Before the check, this object was returned as the init
    // payload and rendered into an empty banner.
    assert.equal(holdsInitPayload({ data: MCP_SHAPE }), false);
  });

  it('refuses on any of the singular type keys, not just iron_rule', () => {
    for (const key of ['iron_rule', 'coding_standard', 'team_standard', 'standard_detail']) {
      assert.equal(holdsInitPayload({ data: { [key]: [] } }), false, `${key} was not recognised`);
    }
  });

  it('an init response carrying the plural forms is still accepted', () => {
    // The discriminator is the singular key. An init response has `iron_rules`, and confusing
    // the two would refuse every legitimate cache and force a download on every session.
    assert.equal(holdsInitPayload({ data: { iron_rules: [], team_standards: [] } }), true);
  });

  it('a missing or malformed payload is refused rather than thrown on', () => {
    for (const bad of [null, undefined, {}, { data: null }, { data: 'text' }, { data: 42 }]) {
      assert.equal(holdsInitPayload(bad), false, `${JSON.stringify(bad)} slipped through`);
    }
  });
});

describe('readCache refuses a foreign payload even when everything else matches', () => {
  const account = { apiUrl: 'https://s/ownmind', apiKey: 'k-1234567890' };

  /** Write a cache file that passes every other gate: right account, fresh token. */
  const write = (dir, data) => {
    const p = path.join(dir, 'memories.json');
    fs.writeFileSync(p, JSON.stringify({
      sync_token: 'f58a19cfdc83',
      saved_at: new Date().toISOString(),
      account: accountFingerprint(account),
      data,
    }));
    return p;
  };

  it('the type-keyed cache is treated as absent', () => {
    const dir = tempDir('ownmind-cachefile-');
    try {
      // Account stamp correct, token present, saved_at fresh — the only thing wrong is the
      // shape, which is exactly the state the measured machine was in.
      assert.equal(readCache(write(dir, MCP_SHAPE), fs, account), null,
        'the hook would hand this to renderSessionContext and produce an empty banner');
      // And the machine heals: an absent cache means a full download on the next session.
      assert.notEqual(readCache(write(dir, INIT_SHAPE), fs, account), null,
        'a legitimate cache must still be served, or every session re-downloads');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
