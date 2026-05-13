import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateSyncToken, validateSyncToken } from '../src/utils/syncToken.js';

/**
 * v1.18.0 — GET /api/memory/sync-token endpoint behavior tests
 *
 * 測 generateSyncToken pure function（mock query injection）+ verify
 * endpoint response shape 對齊 spec.md §4.1。
 *
 * 注意：endpoint handler 本身只是 generateSyncToken + JSON wrap、3 行邏輯。
 * 主要測 generateSyncToken 行為 + response shape 假設。
 */

function fakeQueryWithRows(rows) {
  return async () => ({ rows });
}

describe('v1.18.0 — generateSyncToken (sync-token endpoint 核心邏輯)', () => {
  it('回 12 字 hex string', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]);
    const token = await generateSyncToken(1, fakeQuery);
    assert.equal(typeof token, 'string');
    assert.equal(token.length, 12);
    assert.match(token, /^[0-9a-f]{12}$/, 'must be 12-char hex (sha256 prefix)');
  });

  it('同 user_max + team_max 同 userId → idempotent (同 token)', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '2026-05-12T00:00:00Z' }]);
    const t1 = await generateSyncToken(1, fakeQuery);
    const t2 = await generateSyncToken(1, fakeQuery);
    assert.equal(t1, t2, 'same input → same token');
  });

  it('user_max 變 → token 變', async () => {
    const t1 = await generateSyncToken(1, fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]));
    const t2 = await generateSyncToken(1, fakeQueryWithRows([{ user_max: '2026-05-13T00:00:01Z', team_max: '' }]));
    assert.notEqual(t1, t2, 'updated_at 變 → token 變');
  });

  it('team_max 變 → token 變', async () => {
    const t1 = await generateSyncToken(1, fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: 'A' }]));
    const t2 = await generateSyncToken(1, fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: 'B' }]));
    assert.notEqual(t1, t2, 'team_standard 變也算');
  });

  it('userId 不同 → token 不同（同 max）', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]);
    const t1 = await generateSyncToken(1, fakeQuery);
    const t2 = await generateSyncToken(2, fakeQuery);
    assert.notEqual(t1, t2, 'userId 是 hash input 之一');
  });

  it('null user_max + null team_max 仍可算（新 user 0 鐵律情境）', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '', team_max: '' }]);
    const token = await generateSyncToken(99, fakeQuery);
    assert.match(token, /^[0-9a-f]{12}$/);
  });

  it('endpoint response shape: { sync_token } 預期 < 100 bytes', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]);
    const token = await generateSyncToken(1, fakeQuery);
    const responseBody = JSON.stringify({ sync_token: token });
    assert.ok(responseBody.length < 100, `response body 應 < 100 bytes、實際 ${responseBody.length}`);
    const parsed = JSON.parse(responseBody);
    assert.equal(typeof parsed.sync_token, 'string');
    assert.equal(parsed.sync_token.length, 12);
  });
});

describe('v1.18.0 — validateSyncToken (寫入端 stale check 沿用、不變)', () => {
  it('client token 跟 server 算一樣 → valid: true', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]);
    const serverToken = await generateSyncToken(1, fakeQuery);
    const r = await validateSyncToken(1, serverToken, fakeQuery);
    assert.equal(r.valid, true);
  });

  it('client token 不同 → valid: false + new_token', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]);
    const r = await validateSyncToken(1, 'stale-token', fakeQuery);
    assert.equal(r.valid, false);
    assert.match(r.new_token, /^[0-9a-f]{12}$/);
  });

  it('client token 缺 → valid: false', async () => {
    const fakeQuery = fakeQueryWithRows([{ user_max: '2026-05-13T00:00:00Z', team_max: '' }]);
    const r = await validateSyncToken(1, null, fakeQuery);
    assert.equal(r.valid, false);
  });
});
