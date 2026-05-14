import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrichErrorDetails, errorAliasFields } from '../mcp/lib/enrich-error.js';

/**
 * v1.18.6 — enrichErrorDetails 單元測試
 *
 * 為什麼：
 *   v1.18.6 把 error event details 從 { tool_name, error } 兩欄擴成
 *   { error, error_message, error_name, tool_name, stack?, http_status?, payload_summary? }
 *   helper 是 pure function、適合用 unit test 鎖死行為、防止退步。
 */

describe('enrichErrorDetails', () => {
  describe('基本欄位', () => {
    it('Error 物件帶 message 時、error 和 error_message 都填入', () => {
      const result = enrichErrorDetails(new Error('API 400: 鐵律檢查失敗'), 'ownmind_save', null);
      assert.equal(result.error, 'API 400: 鐵律檢查失敗');
      assert.equal(result.error_message, 'API 400: 鐵律檢查失敗');
      assert.equal(result.error_name, 'Error');
      assert.equal(result.tool_name, 'ownmind_save');
    });

    it('TypeError 等子類別、error_name 反映 class 名', () => {
      const result = enrichErrorDetails(new TypeError('Cannot read foo'), 'ownmind_get', null);
      assert.equal(result.error_name, 'TypeError');
    });

    it('純字串 error 也能 graceful 處理（不爆）', () => {
      const result = enrichErrorDetails('plain string error', 'ownmind_search', null);
      assert.equal(result.error, 'plain string error');
      assert.equal(result.error_message, 'plain string error');
      assert.equal(result.error_name, 'Error');
    });

    it('null error 也能 graceful 處理', () => {
      const result = enrichErrorDetails(null, 'ownmind_init', null);
      assert.equal(result.error, '');
      assert.equal(result.error_message, '');
      assert.equal(result.error_name, 'Error');
    });
  });

  describe('stack 截短', () => {
    it('Error 有 stack 時、截短到前 5 行', () => {
      const err = new Error('boom');
      const result = enrichErrorDetails(err, 'ownmind_update', null);
      assert.ok(result.stack, 'stack 應該存在');
      assert.ok(result.stack.split('\n').length <= 5, 'stack 不能超過 5 行');
    });

    it('字串 error 沒 stack、欄位不出現', () => {
      const result = enrichErrorDetails('no stack', 'ownmind_save', null);
      assert.ok(!('stack' in result), '字串 error 不該有 stack 欄位');
    });
  });

  describe('http_status regex', () => {
    it('"API 400: ..." 抓到 400', () => {
      const result = enrichErrorDetails(new Error('API 400: 鐵律檢查失敗'), 'ownmind_save', null);
      assert.equal(result.http_status, 400);
    });

    it('"API 409: ..." 抓到 409', () => {
      const result = enrichErrorDetails(new Error('API 409: sync_token 過期'), 'ownmind_update', null);
      assert.equal(result.http_status, 409);
    });

    it('不是 API NNN: 開頭、http_status 不出現', () => {
      const result = enrichErrorDetails(new Error('TypeError: foo'), 'ownmind_get', null);
      assert.ok(!('http_status' in result), '非 API 錯誤不該有 http_status');
    });

    it('"API 400:" 但內文不對、仍抓 400（regex 只看開頭）', () => {
      const result = enrichErrorDetails(new Error('API 400: anything'), 'ownmind_save', null);
      assert.equal(result.http_status, 400);
    });
  });

  describe('payload_summary 隱私邊界', () => {
    it('帶 type / code / id 結構欄位、進 summary', () => {
      const result = enrichErrorDetails(
        new Error('API 400'),
        'ownmind_save',
        { type: 'iron_rule', code: 'IR-099', id: 42 }
      );
      assert.deepEqual(result.payload_summary, {
        type: 'iron_rule',
        code: 'IR-099',
        id: 42,
      });
    });

    it('title / content 只記長度、不記內容（隱私保護）', () => {
      const result = enrichErrorDetails(
        new Error('API 400'),
        'ownmind_save',
        { title: 'super secret', content: 'a'.repeat(500) }
      );
      assert.equal(result.payload_summary.title_length, 12);
      assert.equal(result.payload_summary.content_length, 500);
      assert.ok(!('title' in result.payload_summary), 'title 內容絕對不能進 summary');
      assert.ok(!('content' in result.payload_summary), 'content 內容絕對不能進 summary');
    });

    it('tags 只記數量、不記內容', () => {
      const result = enrichErrorDetails(
        new Error('API 400'),
        'ownmind_save',
        { tags: ['trigger:edit', 'iron_rule', 'secret'] }
      );
      assert.equal(result.payload_summary.tags_count, 3);
      assert.ok(!('tags' in result.payload_summary), 'tags 內容不該進 summary');
    });

    it('args 是 null、payload_summary 不出現', () => {
      const result = enrichErrorDetails(new Error('boom'), 'ownmind_init', null);
      assert.ok(!('payload_summary' in result), 'null args 不該有 payload_summary');
    });

    it('args 是空 object、payload_summary 不出現（沒可記欄位）', () => {
      const result = enrichErrorDetails(new Error('boom'), 'ownmind_init', {});
      assert.ok(!('payload_summary' in result), '空 args 不該有 payload_summary');
    });

    it('args 是非 object（字串）、payload_summary 不出現', () => {
      const result = enrichErrorDetails(new Error('boom'), 'tool', 'not an object');
      assert.ok(!('payload_summary' in result), '非 object args 不該有 payload_summary');
    });

    it('id === 0 也算數（避免 falsy check bug）', () => {
      const result = enrichErrorDetails(
        new Error('boom'),
        'ownmind_update',
        { id: 0 }
      );
      assert.equal(result.payload_summary.id, 0);
    });
  });

  describe('向後相容', () => {
    it('error 欄位永遠存在、舊 query 不會壞', () => {
      const result = enrichErrorDetails(new Error('boom'), 'tool', null);
      assert.ok('error' in result, 'error 欄位必須保留供舊 dashboard 用');
    });

    it('error 跟 error_message 內容一致（同一個 message 鏡像兩欄）', () => {
      const result = enrichErrorDetails(new Error('boom'), 'tool', null);
      assert.equal(result.error, result.error_message);
    });
  });
});

describe('errorAliasFields (v1.18.7 update_failed event 共用 helper)', () => {
  it('Error 物件帶 message + code (syscall) 同時填 error_message 和 error_code', () => {
    const e = new Error('EEXIST: file already exists');
    e.code = 'EEXIST';
    const fields = errorAliasFields(e);
    assert.equal(fields.error_message, 'EEXIST: file already exists');
    assert.equal(fields.error_code, 'EEXIST');
    assert.equal(fields.error_name, 'Error');
  });

  it('沒 code（如 API error）— error_code 不出現', () => {
    const fields = errorAliasFields(new Error('API 400: bad request'));
    assert.ok(!('error_code' in fields), 'API error 沒 syscall code、欄位不該出現');
    assert.equal(fields.http_status, 400);
  });

  it('純字串 error 不爆、error_name 預設 Error', () => {
    const fields = errorAliasFields('lock contention');
    assert.equal(fields.error_message, 'lock contention');
    assert.equal(fields.error_name, 'Error');
    assert.ok(!('error_code' in fields));
    assert.ok(!('stack' in fields));
  });

  it('null 也 graceful', () => {
    const fields = errorAliasFields(null);
    assert.equal(fields.error_message, '');
    assert.equal(fields.error_name, 'Error');
  });

  it('沒 tool_name / payload_summary 欄位（這些是 caller-specific）', () => {
    const fields = errorAliasFields(new Error('boom'));
    assert.ok(!('tool_name' in fields), 'tool_name 由 caller 自己組');
    assert.ok(!('payload_summary' in fields), 'payload_summary 由 caller 自己組');
    assert.ok(!('error' in fields), 'error 欄位由 caller 自己組（決定向後相容策略）');
  });

  it('用在 update_failed 情境：caller 帶 e.code || e.message、helper 補 alias', () => {
    const e = new Error('EEXIST: file already exists');
    e.code = 'EEXIST';
    // 模擬 mcp/index.js update_failed payload 組裝
    const payload = {
      source: 'mcp',
      step: 'lock',
      error: e.code || e.message,    // caller 保留 fallback
      ...errorAliasFields(e),
    };
    assert.equal(payload.error, 'EEXIST');                          // caller 邏輯：簡短 code 優先
    assert.equal(payload.error_message, 'EEXIST: file already exists');  // helper：純 message
    assert.equal(payload.error_code, 'EEXIST');
    assert.equal(payload.source, 'mcp');
    assert.equal(payload.step, 'lock');
  });
});
