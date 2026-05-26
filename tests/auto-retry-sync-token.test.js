import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRetryForSyncToken, applyNewToken } from '../mcp/lib/sync-token-retry.js';

describe('v1.20.2 follow-up #2：sync_token 自動 retry helper', () => {

  describe('shouldRetryForSyncToken', () => {
    it('寫入 POST + 409 + 訊息含 sync_token → true', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'POST',
        status: 409,
        errorMessage: 'API 409: 請先呼叫 ownmind_init 取得 sync_token 後再進行寫入操作'
      }), true);
    });

    it('寫入 PUT + 409 + 訊息含 sync_token → true', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'PUT',
        status: 409,
        errorMessage: 'API 409: sync_token 已過期'
      }), true);
    });

    it('寫入 DELETE + 409 + 訊息含 sync_token → true', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'DELETE',
        status: 409,
        errorMessage: 'sync_token mismatch'
      }), true);
    });

    it('GET + 409 → false（讀取操作不該 retry）', () => {
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

    it('POST + 200 → false（成功不該 retry）', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'POST',
        status: 200,
        errorMessage: ''
      }), false);
    });

    it('POST + 409 + 訊息不含 sync_token → false（其他 409 不該誤 retry）', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'POST',
        status: 409,
        errorMessage: 'API 409: 資料重複'
      }), false);
    });

    it('POST + 500 + 訊息含 sync_token → false（必須是 409 才 retry）', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'POST',
        status: 500,
        errorMessage: 'sync_token error'
      }), false);
    });

    it('errorMessage 為 undefined → false（防呆）', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'POST',
        status: 409,
        errorMessage: undefined
      }), false);
    });

    it('errorMessage 大小寫不敏感（Sync_Token 也算）', () => {
      assert.equal(shouldRetryForSyncToken({
        method: 'POST',
        status: 409,
        errorMessage: 'Sync_Token mismatch'
      }), true);
    });
  });

  describe('applyNewToken', () => {
    it('body 有 sync_token 欄位 → 換成新值、回 true', () => {
      const body = { type: 'project', sync_token: 'old-abc' };
      const result = applyNewToken(body, 'new-xyz');
      assert.equal(result, true);
      assert.equal(body.sync_token, 'new-xyz');
    });

    it('body 沒 sync_token 欄位 → 不動、回 false', () => {
      const body = { type: 'project' };
      const result = applyNewToken(body, 'new-xyz');
      assert.equal(result, false);
      assert.ok(!('sync_token' in body), 'body 不應該被新增 sync_token 欄位');
    });

    it('body 為 null → 回 false 不 crash', () => {
      const result = applyNewToken(null, 'new-xyz');
      assert.equal(result, false);
    });

    it('body 為 undefined → 回 false 不 crash', () => {
      const result = applyNewToken(undefined, 'new-xyz');
      assert.equal(result, false);
    });

    it('newToken 為 null → 回 false 不破壞 body', () => {
      const body = { sync_token: 'old' };
      const result = applyNewToken(body, null);
      assert.equal(result, false);
      assert.equal(body.sync_token, 'old', '原 token 不應該被覆蓋成 null');
    });

    it('newToken 為空字串 → 回 false', () => {
      const body = { sync_token: 'old' };
      const result = applyNewToken(body, '');
      assert.equal(result, false);
      assert.equal(body.sync_token, 'old');
    });

    it('body 是字串而非物件 → 回 false 不 crash', () => {
      const result = applyNewToken('not an object', 'new-xyz');
      assert.equal(result, false);
    });
  });
});
