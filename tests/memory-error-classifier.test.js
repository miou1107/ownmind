import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMemoryError } from '../src/utils/memory-error-classifier.js';

/**
 * v1.19.1 — memory-error-classifier unit test
 *
 * Maps to openspec/changes/v1.19.1-secret-tool-routing/proposal.md §2.3 / spec.md scenarios 10, 11.
 *
 * Splits the original catch-all 500 "update/create memory failed" black box
 * into per-error-class routing:
 *   - PG constraint violation (23xxx): 400 + hint
 *   - PG unique violation (23505): 409 + hint about duplicate data
 *   - PG connection exception (08xxx): 503 + hint to retry later
 *   - JS SyntaxError (JSON parse, etc.): 400
 *   - Other unclassified: 500 + log stack (for debugging)
 */

describe('classifyMemoryError — PG constraint violations', () => {
  it('check_violation (23514) → 400 + hint', () => {
    const err = Object.assign(new Error('new row for relation violates check constraint'), {
      code: '23514',
      constraint: 'memories_tier_check',
    });
    const result = classifyMemoryError(err);
    assert.equal(result.status, 400);
    assert.ok(result.body.error.length > 0);
    assert.ok(result.body.hint.includes('違反') || result.body.hint.includes('限制'));
    assert.equal(result.body.code, '23514');
    assert.equal(result.logStack, false);
  });

  it('not_null_violation (23502) → 400 + hint about column not being empty', () => {
    const err = Object.assign(
      new Error('null value in column "content" violates not-null constraint'),
      { code: '23502', column: 'content' }
    );
    const result = classifyMemoryError(err);
    assert.equal(result.status, 400);
    assert.ok(result.body.hint.includes('空'));
  });

  it('foreign_key_violation (23503) → 400 + hint', () => {
    const err = Object.assign(new Error('insert or update violates foreign key'), {
      code: '23503',
    });
    const result = classifyMemoryError(err);
    assert.equal(result.status, 400);
  });

  it('unique_violation (23505) → 409 + hint about duplicate data', () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    const result = classifyMemoryError(err);
    assert.equal(result.status, 409);
    assert.ok(result.body.hint.includes('重複'));
  });
});

describe('classifyMemoryError — PG connection / system errors', () => {
  it('connection_exception (08000) → 503 + hint to retry later', () => {
    const err = Object.assign(new Error('connection refused'), { code: '08000' });
    const result = classifyMemoryError(err);
    assert.equal(result.status, 503);
    assert.ok(result.body.hint.includes('重試'));
    assert.equal(result.logStack, true, 'connection errors should log stack for debugging');
  });

  it('connection_failure (08006) → 503', () => {
    const err = Object.assign(new Error('connection failure'), { code: '08006' });
    const result = classifyMemoryError(err);
    assert.equal(result.status, 503);
  });

  it('connection terminated (Node ECONNREFUSED) → 503', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const result = classifyMemoryError(err);
    assert.equal(result.status, 503);
  });
});

describe('classifyMemoryError — JS built-in errors', () => {
  it('SyntaxError → 400 "data format error"', () => {
    const err = new SyntaxError('Unexpected token in JSON');
    const result = classifyMemoryError(err);
    assert.equal(result.status, 400);
    assert.ok(result.body.error.includes('格式'));
  });

  it('TypeError → 500 (program bug, must log stack)', () => {
    const err = new TypeError('Cannot read property foo of undefined');
    const result = classifyMemoryError(err);
    assert.equal(result.status, 500);
    assert.equal(result.logStack, true);
  });
});

describe('classifyMemoryError — boundaries and defaults', () => {
  it('unclassified Error → 500 + log stack', () => {
    const err = new Error('something weird happened');
    const result = classifyMemoryError(err);
    assert.equal(result.status, 500);
    assert.equal(result.logStack, true);
    assert.ok(result.body.error.length > 0);
  });

  it('null → 500 fallback, does not throw', () => {
    const result = classifyMemoryError(null);
    assert.equal(result.status, 500);
  });

  it('undefined → 500 fallback, does not throw', () => {
    const result = classifyMemoryError(undefined);
    assert.equal(result.status, 500);
  });

  it('string → 500 fallback', () => {
    const result = classifyMemoryError('error message string');
    assert.equal(result.status, 500);
  });

  it('object with status → reuse caller-provided status', () => {
    const err = Object.assign(new Error('explicit 422'), { status: 422 });
    const result = classifyMemoryError(err);
    assert.equal(result.status, 422);
  });
});

describe('classifyMemoryError — response shape', () => {
  it('body must have error string', () => {
    const result = classifyMemoryError(new Error('test'));
    assert.equal(typeof result.body.error, 'string');
    assert.ok(result.body.error.length > 0);
  });

  it('400 / 409 do not log stack (avoid noisy log)', () => {
    const constraint = Object.assign(new Error('constraint'), { code: '23514' });
    assert.equal(classifyMemoryError(constraint).logStack, false);

    const dup = Object.assign(new Error('dup'), { code: '23505' });
    assert.equal(classifyMemoryError(dup).logStack, false);
  });

  it('500 / 503 always log stack (for debugging)', () => {
    const conn = Object.assign(new Error('conn'), { code: '08000' });
    assert.equal(classifyMemoryError(conn).logStack, true);

    const generic = new Error('whatever');
    assert.equal(classifyMemoryError(generic).logStack, true);
  });

  it('logLevel: 4xx is warn, 5xx is error', () => {
    const constraint = Object.assign(new Error('c'), { code: '23514' });
    assert.equal(classifyMemoryError(constraint).logLevel, 'warn');

    const generic = new Error('g');
    assert.equal(classifyMemoryError(generic).logLevel, 'error');
  });
});

describe('classifyMemoryError — context parameter', () => {
  it('context=create → error message contains "建立"', () => {
    const result = classifyMemoryError(new Error('x'), { context: 'create' });
    assert.ok(result.body.error.includes('建立'));
  });

  it('context=update → error message contains "更新"', () => {
    const result = classifyMemoryError(new Error('x'), { context: 'update' });
    assert.ok(result.body.error.includes('更新'));
  });

  it('context not provided → generic message "處理記憶失敗"', () => {
    const result = classifyMemoryError(new Error('x'));
    assert.ok(result.body.error.length > 0);
  });
});
