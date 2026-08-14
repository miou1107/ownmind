import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateSyncToken,
  validateSyncToken,
  generateIronRuleLockToken,
  validateIronRuleLockToken,
} from '../src/utils/syncToken.js';

/**
 * v1.18.0 — GET /api/memory/sync-token endpoint behavior tests
 *
 * Tests the pure function generateSyncToken via mock query injection and verifies
 * the endpoint response shape matches spec.md §4.1.
 *
 * Note: the endpoint handler itself is just generateSyncToken + a JSON wrap, ~3 lines.
 * This file focuses on generateSyncToken behavior and the assumed response shape.
 */

function fakeQueryWithRows(rows) {
  return async () => ({ rows });
}

describe('v1.18.0 — generateSyncToken (core logic behind the sync-token endpoint)', () => {
  it('returns a 12-char hex string', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]);
    const token = await generateSyncToken(1, fakeQuery);
    assert.equal(typeof token, 'string');
    assert.equal(token.length, 12);
    assert.match(token, /^[0-9a-f]{12}$/, 'must be 12-char hex (sha256 prefix)');
  });

  it('same user_max + team_max + same userId → idempotent (same token)', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '2026-05-12T00:00:00Z' }]);
    const t1 = await generateSyncToken(1, fakeQuery);
    const t2 = await generateSyncToken(1, fakeQuery);
    assert.equal(t1, t2, 'same input → same token');
  });

  it('user_max changes → token changes', async () => {
    const t1 = await generateSyncToken(1, fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]));
    const t2 = await generateSyncToken(1, fakeQueryWithRows([{ user_max: '2026-05-13T00:00:01Z', team_max: '' }]));
    assert.notEqual(t1, t2, 'updated_at change → token change');
  });

  it('team_max changes → token changes', async () => {
    const t1 = await generateSyncToken(1, fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: 'A' }]));
    const t2 = await generateSyncToken(1, fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: 'B' }]));
    assert.notEqual(t1, t2, 'team_standard change counts too');
  });

  // Task 5 fix round 1 (gate-message-i18n): a locale write touches users.settings, never
  // memories.updated_at, so a hash built only from MAX(updated_at) can never change when the
  // account's language preference changes — the propagation review that caught this. locale
  // must be a first-class hash input, same tier as user_max/team_max.
  it('locale changes → token changes (same user_max/team_max)', async () => {
    const base = { user_max: '2026-05-13T00:00:00Z', team_max: '' };
    const t1 = await generateSyncToken(1, fakeQueryWithRows([{ ...base, locale: 'zh' }]));
    const t2 = await generateSyncToken(1, fakeQueryWithRows([{ ...base, locale: 'ja' }]));
    assert.notEqual(t1, t2, 'a locale-only change must still bump the token');
  });

  it('locale unset (auto) differs from any pinned locale, same user_max/team_max', async () => {
    const base = { user_max: '2026-05-13T00:00:00Z', team_max: '' };
    const withZh = await generateSyncToken(1, fakeQueryWithRows([{ ...base, locale: 'zh' }]));
    const cleared = await generateSyncToken(1, fakeQueryWithRows([{ ...base, locale: '' }]));
    assert.notEqual(withZh, cleared, 'clearing the preference (auto) must also bump the token');
  });

  it('same locale + same user_max/team_max → idempotent (same token)', async () => {
    const row = { user_max: '2026-05-13T00:00:00Z', team_max: '', locale: 'en' };
    const t1 = await generateSyncToken(1, fakeQueryWithRows([row]));
    const t2 = await generateSyncToken(1, fakeQueryWithRows([row]));
    assert.equal(t1, t2, 'same input including locale → same token');
  });

  it('different userId → different token (same max)', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]);
    const t1 = await generateSyncToken(1, fakeQuery);
    const t2 = await generateSyncToken(2, fakeQuery);
    assert.notEqual(t1, t2, 'userId is part of the hash input');
  });

  it('null user_max + null team_max still computes (new user with 0 iron rules)', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '', team_max: '' }]);
    const token = await generateSyncToken(99, fakeQuery);
    assert.match(token, /^[0-9a-f]{12}$/);
  });

  it('endpoint response shape: { sync_token } expected < 100 bytes', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]);
    const token = await generateSyncToken(1, fakeQuery);
    const responseBody = JSON.stringify({ sync_token: token });
    assert.ok(responseBody.length < 100, `response body should be < 100 bytes; actual ${responseBody.length}`);
    const parsed = JSON.parse(responseBody);
    assert.equal(typeof parsed.sync_token, 'string');
    assert.equal(parsed.sync_token.length, 12);
  });
});

/**
 * Task 5 fix round 2 (gate-message-i18n) — the cache-freshness token's wire value.
 *
 * This token is not an internal detail: every installed client has one on disk
 * (`~/.ownmind/cache/memories.json`), and `hooks/lib/conditional-sync.js` re-downloads the
 * whole init payload the moment the server's value stops matching. So a change to how the
 * hash inputs are *formatted* — not to what they mean — bills every account one full
 * re-init for nothing. The round-2 refactor moved the joining into a shared helper; this
 * pins the resulting bytes so that move stayed value-preserving, and so any future one has
 * to be deliberate rather than accidental.
 */
describe('cache-freshness token — wire value is stable across refactors', () => {
  it('a known input still hashes to the same 12 hex chars', async () => {
    const token = await generateSyncToken(
      1, fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '', locale: '' }]),
    );
    // sha256('1:2026-05-13T00:00:00Z::').slice(0, 12) — the format shipped to clients.
    assert.equal(token, '8ac6381b9d96');
  });

  it('all four inputs distinct and non-empty still hash to the same 12 hex chars', async () => {
    // The case above leaves team_max and locale empty, so a refactor that mangled only one of
    // them — trimmed it, lowercased it, reordered it against the others — would slip past.
    const token = await generateSyncToken(
      7, fakeQueryWithRows([{
        user_max: '2026-05-13T00:00:00Z', team_max: '2026-05-12T00:00:00Z', locale: 'ja',
      }]),
    );
    // sha256('7:2026-05-13T00:00:00Z:2026-05-12T00:00:00Z:ja').slice(0, 12)
    assert.equal(token, '10849375c58e');
  });

  it('an absent locale column hashes identically to an empty one (no re-init for old rows)', async () => {
    const withoutColumn = await generateSyncToken(
      1, fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]),
    );
    assert.equal(withoutColumn, '8ac6381b9d96');
  });
});

/**
 * Task 5 fix round 2 (gate-message-i18n) — the iron-rule concurrency lock.
 *
 * Round 1 folded the account's locale into `generateSyncToken`, which is right for the
 * cache-freshness question ("has anything the client caches changed?") and wrong for the
 * only other caller, `src/routes/admin-iron-rule-upgrade.js`, which was using the very same
 * hash to answer a different question ("did iron-rule state change under this editor?").
 * With locale in the hash, a user switching their own language mid-edit got a 409 reading
 * "Iron-rule state has changed" when no iron rule had changed at all.
 *
 * The lock therefore gets its own inputs: exactly the rows `GET /upgrade-status` snapshots —
 * the user's active iron rules — and nothing else. Both tokens are still produced by one
 * hash implementation; only the queried inputs differ.
 */
describe('generateIronRuleLockToken (optimistic lock for the iron-rule upgrade editor)', () => {
  it('returns a 12-char hex string, same shape as the cache-freshness token', async () => {
    const token = await generateIronRuleLockToken(
      1, fakeQueryWithRows([{ iron_rule_max: '2026-05-13T00:00:00Z', iron_rule_count: '3' }]),
    );
    assert.match(token, /^[0-9a-f]{12}$/);
  });

  it('locale is NOT an input — a locale write must not break an in-flight edit', async () => {
    const base = { iron_rule_max: '2026-05-13T00:00:00Z', iron_rule_count: '3' };
    const before = await generateIronRuleLockToken(1, fakeQueryWithRows([{ ...base, locale: 'zh' }]));
    const after = await generateIronRuleLockToken(1, fakeQueryWithRows([{ ...base, locale: 'ja' }]));
    assert.equal(before, after,
      'the language preference is not iron-rule state; folding it in is what caused the spurious 409');
  });

  it('an iron-rule write DOES move it (MAX(updated_at) changes)', async () => {
    const t1 = await generateIronRuleLockToken(
      1, fakeQueryWithRows([{ iron_rule_max: '2026-05-13T00:00:00Z', iron_rule_count: '3' }]),
    );
    const t2 = await generateIronRuleLockToken(
      1, fakeQueryWithRows([{ iron_rule_max: '2026-05-13T00:00:01Z', iron_rule_count: '3' }]),
    );
    assert.notEqual(t1, t2);
  });

  it('a rule leaving the active set moves it even when MAX(updated_at) does not', async () => {
    // Disabling a rule that is not the most recently touched one leaves MAX where it was.
    // Without the count, the editor's snapshot would silently no longer match the list.
    const t1 = await generateIronRuleLockToken(
      1, fakeQueryWithRows([{ iron_rule_max: '2026-05-13T00:00:00Z', iron_rule_count: '3' }]),
    );
    const t2 = await generateIronRuleLockToken(
      1, fakeQueryWithRows([{ iron_rule_max: '2026-05-13T00:00:00Z', iron_rule_count: '2' }]),
    );
    assert.notEqual(t1, t2);
  });

  it('different userId → different token (same iron-rule state)', async () => {
    const fakeQuery = fakeQueryWithRows([{ iron_rule_max: '2026-05-13T00:00:00Z', iron_rule_count: '3' }]);
    assert.notEqual(await generateIronRuleLockToken(1, fakeQuery), await generateIronRuleLockToken(2, fakeQuery));
  });

  it('a user with zero iron rules still computes', async () => {
    const token = await generateIronRuleLockToken(
      99, fakeQueryWithRows([{ iron_rule_max: '', iron_rule_count: '0' }]),
    );
    assert.match(token, /^[0-9a-f]{12}$/);
  });

  it('the two token spaces are disjoint: identical raw inputs still hash differently', async () => {
    // Both scopes are namespaced into the hash, so a token from one family pasted into the
    // other can only ever fail the comparison — never accidentally satisfy it.
    const row = { user_max: 'X', team_max: '', locale: '', iron_rule_max: 'X', iron_rule_count: '' };
    const cacheToken = await generateSyncToken(1, fakeQueryWithRows([row]));
    const lockToken = await generateIronRuleLockToken(1, fakeQueryWithRows([row]));
    assert.notEqual(cacheToken, lockToken);
  });
});

describe('validateIronRuleLockToken', () => {
  const fakeQuery = fakeQueryWithRows([{ iron_rule_max: '2026-05-13T00:00:00Z', iron_rule_count: '3' }]);

  it('echoed token still matching current iron-rule state → valid: true', async () => {
    const serverToken = await generateIronRuleLockToken(1, fakeQuery);
    assert.deepEqual(await validateIronRuleLockToken(1, serverToken, fakeQuery), { valid: true });
  });

  it('stale token → valid: false + new_token', async () => {
    const r = await validateIronRuleLockToken(1, 'stale-token', fakeQuery);
    assert.equal(r.valid, false);
    assert.match(r.new_token, /^[0-9a-f]{12}$/);
  });

  it('missing token → valid: false (same contract as validateSyncToken)', async () => {
    assert.equal((await validateIronRuleLockToken(1, null, fakeQuery)).valid, false);
  });

  it('a cache-freshness token handed to the lock is rejected, not silently accepted', async () => {
    const row = { user_max: '2026-05-13T00:00:00Z', team_max: '', locale: '',
      iron_rule_max: '2026-05-13T00:00:00Z', iron_rule_count: '3' };
    const cacheToken = await generateSyncToken(1, fakeQueryWithRows([row]));
    const r = await validateIronRuleLockToken(1, cacheToken, fakeQueryWithRows([row]));
    assert.equal(r.valid, false, 'crossing the two families must fail loudly');
  });
});

describe('v1.18.0 — validateSyncToken (stale-check for writes, unchanged)', () => {
  it('client token matches server-computed value → valid: true', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]);
    const serverToken = await generateSyncToken(1, fakeQuery);
    const r = await validateSyncToken(1, serverToken, fakeQuery);
    assert.equal(r.valid, true);
  });

  it('client token differs → valid: false + new_token', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]);
    const r = await validateSyncToken(1, 'stale-token', fakeQuery);
    assert.equal(r.valid, false);
    assert.match(r.new_token, /^[0-9a-f]{12}$/);
  });

  it('client token missing → valid: false', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]);
    const r = await validateSyncToken(1, null, fakeQuery);
    assert.equal(r.valid, false);
  });
});
