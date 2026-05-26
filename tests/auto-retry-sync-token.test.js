import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRetryForSyncToken, applyNewToken } from '../mcp/lib/sync-token-retry.js';

describe('v1.20.2 follow-up #2: sync_token auto-retry helper', () => {

  describe('shouldRetryForSyncToken', () => {
    it('write POST + 409 + message contains sync_token → true', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'POST',
        status: 409,
        errorMessage: 'API 409: Call ownmind_init first to obtain a sync_token before performing any write operation'
      }), true);
    });

    it('write PUT + 409 + message contains sync_token → true', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'PUT',
        status: 409,
        errorMessage: 'API 409: sync_token 已過期'
      }), true);
    });

    it('write DELETE + 409 + message contains sync_token → true', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'DELETE',
        status: 409,
        errorMessage: 'sync_token mismatch'
      }), true);
    });

    it('GET + 409 → false (reads should not retry)', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'GET',
        status: 409,
        errorMessage: 'sync_token 過期'
      }), false);
    });

    it('HEAD + 409 → false', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'HEAD',
        status: 409,
        errorMessage: 'sync_token 過期'
      }), false);
    });

    it('POST + 200 → false (success should not retry)', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'POST',
        status: 200,
        errorMessage: ''
      }), false);
    });

    it('POST + 409 + message does not mention sync_token → false (other 409s must not retry by mistake)', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'POST',
        status: 409,
        errorMessage: 'API 409: 資料重複'
      }), false);
    });

    it('POST + 500 + message contains sync_token → false (only 409 triggers retry)', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'POST',
        status: 500,
        errorMessage: 'sync_token error'
      }), false);
    });

    it('errorMessage is undefined → false (defensive)', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'POST',
        status: 409,
        errorMessage: undefined
      }), false);
    });

    it('errorMessage is case-insensitive (Sync_Token also counts)', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'POST',
        status: 409,
        errorMessage: 'Sync_Token mismatch'
      }), true);
    });
  });

  describe('applyNewToken', () => {
    it('body has a sync_token field → replace with the new value, return true', () => {
      const body = { type: 'project', sync_token: 'old-abc' };
      const result = applyNewToken(body, 'new-xyz');
      assert.equal(result, true);
      assert.equal(body.sync_token, 'new-xyz');
    });

    it('body has no sync_token field → no change, return false', () => {
      const body = { type: 'project' };
      const result = applyNewToken(body, 'new-xyz');
      assert.equal(result, false);
      assert.ok(!('sync_token' in body), 'body must not gain a sync_token field');
    });

    it('body is null → return false, no crash', () => {
      const result = applyNewToken(null, 'new-xyz');
      assert.equal(result, false);
    });

    it('body is undefined → return false, no crash', () => {
      const result = applyNewToken(undefined, 'new-xyz');
      assert.equal(result, false);
    });

    it('newToken is null → return false, body untouched', () => {
      const body = { sync_token: 'old' };
      const result = applyNewToken(body, null);
      assert.equal(result, false);
      assert.equal(body.sync_token, 'old', 'original token must not be overwritten with null');
    });

    it('newToken is empty string → return false', () => {
      const body = { sync_token: 'old' };
      const result = applyNewToken(body, '');
      assert.equal(result, false);
      assert.equal(body.sync_token, 'old');
    });

    it('body is a string instead of an object → return false, no crash', () => {
      const result = applyNewToken('not an object', 'new-xyz');
      assert.equal(result, false);
    });
  });
});
