import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateSyncToken, validateSyncToken } from '../src/utils/syncToken.js';

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
