import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrichErrorDetails, errorAliasFields } from '../mcp/lib/enrich-error.js';

/**
 * v1.18.6 — enrichErrorDetails unit tests
 *
 * Why:
 *   v1.18.6 expanded error event details from { tool_name, error } to
 *   { error, error_message, error_name, tool_name, stack?, http_status?, payload_summary? }.
 *   The helper is a pure function — a natural fit for unit tests to lock in behavior and
 *   prevent regressions.
 */

describe('enrichErrorDetails', () => {
  describe('basic fields', () => {
    it('Error object with a message: both error and error_message are populated', () => {
      const result = enrichErrorDetails(new Error('API 400: 鐵律檢查失敗'), 'ownmind_save', null);
      assert.equal(result.error, 'API 400: 鐵律檢查失敗');
      assert.equal(result.error_message, 'API 400: 鐵律檢查失敗');
      assert.equal(result.error_name, 'Error');
      assert.equal(result.tool_name, 'ownmind_save');
    });

    it('TypeError and other subclasses: error_name reflects the class name', () => {
      const result = enrichErrorDetails(new TypeError('Cannot read foo'), 'ownmind_get', null);
      assert.equal(result.error_name, 'TypeError');
    });

    it('plain-string error is handled gracefully (no throw)', () => {
      const result = enrichErrorDetails('plain string error', 'ownmind_search', null);
      assert.equal(result.error, 'plain string error');
      assert.equal(result.error_message, 'plain string error');
      assert.equal(result.error_name, 'Error');
    });

    it('null error is handled gracefully', () => {
      const result = enrichErrorDetails(null, 'ownmind_init', null);
      assert.equal(result.error, '');
      assert.equal(result.error_message, '');
      assert.equal(result.error_name, 'Error');
    });
  });

  describe('stack truncation', () => {
    it('Error with a stack: trim to the first 5 lines', () => {
      const err = new Error('boom');
      const result = enrichErrorDetails(err, 'ownmind_update', null);
      assert.ok(result.stack, 'stack should exist');
      assert.ok(result.stack.split('\n').length <= 5, 'stack must not exceed 5 lines');
    });

    it('string error without a stack: field is absent', () => {
      const result = enrichErrorDetails('no stack', 'ownmind_save', null);
      assert.ok(!('stack' in result), 'string error should not have a stack field');
    });
  });

  describe('http_status regex', () => {
    it('"API 400: ..." captures 400', () => {
      const result = enrichErrorDetails(new Error('API 400: 鐵律檢查失敗'), 'ownmind_save', null);
      assert.equal(result.http_status, 400);
    });

    it('"API 409: ..." captures 409', () => {
      const result = enrichErrorDetails(new Error('API 409: sync_token 過期'), 'ownmind_update', null);
      assert.equal(result.http_status, 409);
    });

    it('not "API NNN:" prefix: http_status absent', () => {
      const result = enrichErrorDetails(new Error('TypeError: foo'), 'ownmind_get', null);
      assert.ok(!('http_status' in result), 'non-API errors should have no http_status');
    });

    it('"API 400:" with arbitrary body still captures 400 (regex looks only at the prefix)', () => {
      const result = enrichErrorDetails(new Error('API 400: anything'), 'ownmind_save', null);
      assert.equal(result.http_status, 400);
    });
  });

  describe('payload_summary privacy boundary', () => {
    it('structural fields type / code / id make it into the summary', () => {
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

    it('title / content only record length, never content (privacy guard)', () => {
      const result = enrichErrorDetails(
        new Error('API 400'),
        'ownmind_save',
        { title: 'super secret', content: 'a'.repeat(500) }
      );
      assert.equal(result.payload_summary.title_length, 12);
      assert.equal(result.payload_summary.content_length, 500);
      assert.ok(!('title' in result.payload_summary), 'title content must never enter the summary');
      assert.ok(!('content' in result.payload_summary), 'content must never enter the summary');
    });

    it('tags only record count, never content', () => {
      const result = enrichErrorDetails(
        new Error('API 400'),
        'ownmind_save',
        { tags: ['trigger:edit', 'iron_rule', 'secret'] }
      );
      assert.equal(result.payload_summary.tags_count, 3);
      assert.ok(!('tags' in result.payload_summary), 'tags content should not enter the summary');
    });

    it('args is null → no payload_summary', () => {
      const result = enrichErrorDetails(new Error('boom'), 'ownmind_init', null);
      assert.ok(!('payload_summary' in result), 'null args should produce no payload_summary');
    });

    it('args is an empty object → no payload_summary (nothing recordable)', () => {
      const result = enrichErrorDetails(new Error('boom'), 'ownmind_init', {});
      assert.ok(!('payload_summary' in result), 'empty args should produce no payload_summary');
    });

    it('args is a non-object (string) → no payload_summary', () => {
      const result = enrichErrorDetails(new Error('boom'), 'tool', 'not an object');
      assert.ok(!('payload_summary' in result), 'non-object args should produce no payload_summary');
    });

    it('id === 0 still counts (avoid falsy-check bugs)', () => {
      const result = enrichErrorDetails(
        new Error('boom'),
        'ownmind_update',
        { id: 0 }
      );
      assert.equal(result.payload_summary.id, 0);
    });
  });

  describe('backward compatibility', () => {
    it('error field always exists; old queries do not break', () => {
      const result = enrichErrorDetails(new Error('boom'), 'tool', null);
      assert.ok('error' in result, 'error field must remain for the legacy dashboard');
    });

    it('error and error_message contain the same value (mirror the same message)', () => {
      const result = enrichErrorDetails(new Error('boom'), 'tool', null);
      assert.equal(result.error, result.error_message);
    });
  });
});

describe('errorAliasFields (v1.18.7 update_failed event shared helper)', () => {
  it('Error with message + code (syscall): populates error_message and error_code', () => {
    const e = new Error('EEXIST: file already exists');
    e.code = 'EEXIST';
    const fields = errorAliasFields(e);
    assert.equal(fields.error_message, 'EEXIST: file already exists');
    assert.equal(fields.error_code, 'EEXIST');
    assert.equal(fields.error_name, 'Error');
  });

  it('no code (e.g. API error) — error_code absent', () => {
    const fields = errorAliasFields(new Error('API 400: bad request'));
    assert.ok(!('error_code' in fields), 'API error has no syscall code; field should be absent');
    assert.equal(fields.http_status, 400);
  });

  it('plain-string error does not throw; error_name defaults to Error', () => {
    const fields = errorAliasFields('lock contention');
    assert.equal(fields.error_message, 'lock contention');
    assert.equal(fields.error_name, 'Error');
    assert.ok(!('error_code' in fields));
    assert.ok(!('stack' in fields));
  });

  it('null is handled gracefully too', () => {
    const fields = errorAliasFields(null);
    assert.equal(fields.error_message, '');
    assert.equal(fields.error_name, 'Error');
  });

  it('no tool_name / payload_summary fields (those are caller-specific)', () => {
    const fields = errorAliasFields(new Error('boom'));
    assert.ok(!('tool_name' in fields), 'tool_name is assembled by the caller');
    assert.ok(!('payload_summary' in fields), 'payload_summary is assembled by the caller');
    assert.ok(!('error' in fields), 'error field is assembled by the caller (decides the back-compat policy)');
  });

  it('used in update_failed: caller passes e.code || e.message, helper fills aliases', () => {
    const e = new Error('EEXIST: file already exists');
    e.code = 'EEXIST';
    // Simulate the mcp/index.js update_failed payload assembly.
    const payload = {
      source: 'mcp',
      step: 'lock',
      error: e.code || e.message,    // caller keeps the fallback
      ...errorAliasFields(e),
    };
    assert.equal(payload.error, 'EEXIST');                          // caller policy: short code preferred
    assert.equal(payload.error_message, 'EEXIST: file already exists');  // helper: full message
    assert.equal(payload.error_code, 'EEXIST');
    assert.equal(payload.source, 'mcp');
    assert.equal(payload.step, 'lock');
  });
});
