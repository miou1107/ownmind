/**
 * v1.26.133 — ownmind_init emptied the rule cache it was supposed to fill.
 *
 * The init request asks for `compact=true`. A compact response carries `iron_rules_digest`
 * (a rendered summary) and no `iron_rules` array — by design, that is the point of compact.
 * Both caches written at init read it as though it were the full response:
 *
 *     filterCacheableRules(data.iron_rules || [])     ->  []   ->  written to disk
 *     iron_rule: data.iron_rules || []                ->  []   ->  written to disk
 *
 * Measured on Windows 2026-08-10, client 1.26.132, an account with four iron rules. The rule
 * cache held IR-004 — the only one carrying a `lint_validator` — at 20:25; one `ownmind_init`
 * left it two bytes long at 20:30. The reply-lint Stop hook resolves its validators from that
 * file, so for the rest of the session a reply scoring 67.3% mixed language passed in silence.
 * It looked intermittent because the pre-commit hook rebuilds the cache when it finds it
 * empty: the language rule was enforced after a commit and nowhere else.
 *
 * The same expression blanked `team_standard`, `coding_standard`, `project`, `env` and
 * `portfolio` in the offline cache, which is why an offline init on that machine answered
 * with a profile, two principles and nothing else.
 *
 * One distinction fixes all of it: absent is not empty. A response that cannot answer must
 * leave the cache alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  pickRulesForCache,
  mergeOfflineCacheData,
  previousDataForAccount,
  OFFLINE_CACHE_FIELDS,
} from '../shared/init-cache.js';
import { filterCacheableRules } from '../shared/cacheable-rules.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const IR_004 = {
  id: 854,
  code: 'IR-004',
  type: 'iron_rule',
  title: 'reply in plain language',
  metadata: { lint_validator: { name: 'language_mixed_ratio', params: { threshold: 0.15 } } },
};

/** The shape the server actually returned on 2026-08-10, trimmed to what this file needs. */
const COMPACT_INIT = {
  compact: true,
  sync_token: 'f58a19cfdc83',
  iron_rules_count: 4,
  iron_rules_digest: 'IR-001: ...\nIR-004: ...',
  profile: { id: 790, type: 'profile', title: 'who this account is' },
  principles: [{ id: 853, title: 'push straight to main', code: null }],
};

describe('pickRulesForCache', () => {
  it('uses the response when it carries the rules', () => {
    assert.deepEqual(pickRulesForCache([IR_004], null), [IR_004]);
  });

  it('falls back to a direct fetch when the response is compact', () => {
    assert.deepEqual(pickRulesForCache(undefined, [IR_004]), [IR_004]);
  });

  it('returns null when neither can answer — the caller must not write', () => {
    // This is the whole fix. Null means "unknown"; writing [] here is a claim that the
    // account has no cacheable rules, and every consumer of the file believes it.
    assert.equal(pickRulesForCache(undefined, undefined), null);
    assert.equal(pickRulesForCache(null, null), null);
  });

  it('a genuinely empty list is still an answer', () => {
    // An account whose rules are all reminder-only really does cache nothing, and that has
    // to stay distinguishable from a failed lookup.
    assert.deepEqual(pickRulesForCache([], null), []);
  });

  it('a non-array is not an answer', () => {
    for (const bad of ['rules', 42, {}, { data: [] }]) {
      assert.equal(pickRulesForCache(bad, undefined), null, `${JSON.stringify(bad)} was trusted`);
    }
  });

  it('mutation control: the pre-fix expression loses the rule', () => {
    // Without this the fix is unfalsifiable. `data.iron_rules || []` on a compact response
    // is what shipped, and this shows it really did produce an empty cache.
    const oldWay = filterCacheableRules(COMPACT_INIT.iron_rules || []);
    assert.deepEqual(oldWay, [],
      'the pre-fix expression must be shown to empty the cache, or this test proves nothing');
    const newWay = filterCacheableRules(pickRulesForCache(COMPACT_INIT.iron_rules, [IR_004]));
    assert.deepEqual(newWay.map((r) => r.code), ['IR-004']);
  });
});

describe('mergeOfflineCacheData', () => {
  const previous = {
    profile: [{ id: 790 }],
    principle: [{ id: 853 }],
    iron_rule: [IR_004],
    coding_standard: [{ id: 1 }],
    team_standard: [{ id: 2 }],
    project: [{ id: 3 }],
    env: [{ id: 4 }],
    portfolio: [{ id: 5 }],
  };

  it('keeps every collection a compact response does not carry', () => {
    const merged = mergeOfflineCacheData(previous, COMPACT_INIT, [IR_004]);
    assert.deepEqual(merged.team_standard, previous.team_standard, 'team standards were erased');
    assert.deepEqual(merged.coding_standard, previous.coding_standard);
    assert.deepEqual(merged.project, previous.project);
    assert.deepEqual(merged.env, previous.env);
    assert.deepEqual(merged.portfolio, previous.portfolio);
  });

  it('takes the response where the response answers', () => {
    const full = { ...COMPACT_INIT, team_standards: [{ id: 99 }], projects: [] };
    const merged = mergeOfflineCacheData(previous, full, [IR_004]);
    assert.deepEqual(merged.team_standard, [{ id: 99 }], 'a fresh list must win');
    assert.deepEqual(merged.project, [], 'an explicitly empty list is an answer, and must win');
  });

  it('keeps the cached rules when the rule lookup could not answer', () => {
    const merged = mergeOfflineCacheData(previous, COMPACT_INIT, null);
    assert.deepEqual(merged.iron_rule, [IR_004], 'a failed lookup must not empty the rules');
  });

  it('wraps the profile back into a one-element array', () => {
    const merged = mergeOfflineCacheData(previous, COMPACT_INIT, null);
    assert.deepEqual(merged.profile, [COMPACT_INIT.profile]);
  });

  it('works from nothing at all — a first run has no previous cache', () => {
    const merged = mergeOfflineCacheData(null, COMPACT_INIT, [IR_004]);
    assert.deepEqual(merged.iron_rule, [IR_004]);
    for (const type of Object.keys(OFFLINE_CACHE_FIELDS)) {
      if (type === 'iron_rule') continue;
      assert.ok(Array.isArray(merged[type]), `${type} must still be an array`);
    }
    assert.deepEqual(merged.team_standard, []);
  });

  it('every cache type is covered, so a new one cannot be silently dropped', () => {
    const merged = mergeOfflineCacheData(previous, COMPACT_INIT, null);
    const expected = ['profile', ...Object.keys(OFFLINE_CACHE_FIELDS)].sort();
    assert.deepEqual(Object.keys(merged).sort(), expected);
  });

  it('malformed previous data is treated as absent rather than thrown on', () => {
    for (const bad of [undefined, null, 'cache', 42, { iron_rule: 'not a list' }]) {
      const merged = mergeOfflineCacheData(bad, COMPACT_INIT, null);
      assert.deepEqual(merged.iron_rule, [], `${JSON.stringify(bad)} threw or leaked through`);
    }
  });
});

describe('previousDataForAccount', () => {
  /**
   * Merging asks a question replacing never had to: whose data is on disk?
   *
   * Before this release a compact init blanked most collections, so switching the API key to
   * another account cleared them as a side effect of the defect. Keeping them would leave one
   * account's team standards and projects readable under another's key — which is the failure
   * v1.26.82 found on the SessionStart cache, arriving here through the fix for something else.
   */
  const FP = 'a'.repeat(32);
  const data = { iron_rule: [IR_004], team_standard: [{ id: 2 }] };

  it('returns the data when the stamp matches', () => {
    assert.deepEqual(previousDataForAccount({ account: FP, data }, FP), data);
  });

  it('refuses a cache stamped with another account', () => {
    assert.equal(previousDataForAccount({ account: 'b'.repeat(32), data }, FP), null);
  });

  it('refuses an unattributed cache — strict on purpose', () => {
    // Same call as v1.26.82: no stamp counts as somebody else's, not as ours. Every machine
    // restamps on its next init, so the cost is one session and the benefit is that a file
    // whose owner cannot be established is never trusted.
    assert.equal(previousDataForAccount({ data }, FP), null);
  });

  it('refuses everything when the current account cannot be fingerprinted', () => {
    for (const fp of ['', null, undefined, 42]) {
      assert.equal(previousDataForAccount({ account: FP, data }, fp), null);
    }
  });

  it('a missing or malformed cache is simply absent', () => {
    for (const bad of [null, undefined, 'cache', 42, { account: FP }, { account: FP, data: 'x' }]) {
      assert.equal(previousDataForAccount(bad, FP), null);
    }
  });

  it('and what it refuses, the merge treats as a first run', () => {
    // The end of the chain: refusing has to mean "start empty", not "throw" and not "keep".
    const merged = mergeOfflineCacheData(previousDataForAccount({ data }, FP), COMPACT_INIT, null);
    assert.deepEqual(merged.team_standard, []);
    assert.deepEqual(merged.iron_rule, []);
  });
});

describe('the init handler does not write a cache it cannot fill', () => {
  const code = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  it('mcp/index.js no longer derives the rule cache from `data.iron_rules || []`', () => {
    assert.doesNotMatch(code('mcp/index.js'), /filterCacheableRules\(data\.iron_rules \|\| \[\]\)/,
      'the compact response is being filtered again, which writes [] over the cache');
  });

  it('mcp/index.js no longer stores `data.iron_rules || []` in the offline cache', () => {
    assert.doesNotMatch(code('mcp/index.js'), /iron_rule:\s*data\.iron_rules \|\| \[\]/,
      'the offline cache is being blanked again on every compact init');
  });

  it('it goes through the shared rule instead', () => {
    const src = code('mcp/index.js');
    assert.match(src, /pickRulesForCache\(/, 'the absent/empty distinction has no owner again');
    assert.match(src, /mergeOfflineCacheData\(/, 'the offline cache is replaced rather than merged');
  });

  it('what it merges is gated on the account, and what it writes carries the stamp', () => {
    // Without both halves, merging hands one account's memories to the next key configured
    // on the machine — a hole that only opened because the cache stopped being overwritten.
    const src = code('mcp/index.js');
    assert.match(src, /previousDataForAccount\(readMemoryCache\(\)/,
      'the previous cache is reused without asking whose it is');
    assert.match(src, /account: fingerprint/,
      'the cache is written unstamped, so the next session cannot trust it either');
  });
});

/**
 * The regression proper: a real MCP process, a stub server answering exactly what production
 * answered, and the cache file on disk before and after.
 *
 * The unit tests above pin the rule; this pins that the rule is the one the running program
 * uses. Both are needed — the defect was not in a rule, it was in a call site that never
 * consulted one.
 */
describe('end to end: one init against a compact server must not empty the cache', () => {
  it('leaves IR-004 in cache/iron_rules.json', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-init-'));
    const cachePath = path.join(home, '.ownmind', 'cache', 'iron_rules.json');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    // The state the measured machine was in: a correct cache, written by the pre-commit hook.
    fs.writeFileSync(cachePath, JSON.stringify([IR_004], null, 2));

    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/memory/init')) {
        res.end(JSON.stringify(COMPACT_INIT));
        return;
      }
      if (req.url.startsWith('/api/memory/type/iron_rule')) {
        res.end(JSON.stringify({ data: [IR_004] }));
        return;
      }
      // Heartbeats, activity batches, queue replay: answered so nothing retries or stalls.
      res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;

    const child = spawn(process.execPath, [path.join(repoRoot, 'mcp', 'index.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        OWNMIND_API_URL: url,
        OWNMIND_API_KEY: '00000000-0000-4000-8000-000000000000',
        OWNMIND_TOOL: 'claude-code',
      },
    });

    try {
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      });
      await new Promise((r) => setTimeout(r, 600));
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ownmind_init', arguments: {} } });

      // Wait for the response to id 2 rather than a fixed sleep: the cache is written on the
      // way to producing it, so its arrival is the signal that the write has happened.
      const deadline = Date.now() + 20000;
      let answered = false;
      while (Date.now() < deadline && !answered) {
        answered = out.split('\n').filter(Boolean).some((l) => {
          try { return JSON.parse(l).id === 2; } catch { return false; }
        });
        if (!answered) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(answered, `the MCP never answered ownmind_init: ${out.slice(0, 400)}`);

      const after = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      assert.equal(after.length, 1,
        'the compact init emptied the rule cache — this is the v1.26.133 defect');
      assert.equal(after[0].code, 'IR-004');
    } finally {
      child.kill();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
