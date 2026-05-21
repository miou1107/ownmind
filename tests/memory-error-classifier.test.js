import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMemoryError } from '../src/utils/memory-error-classifier.js';

/**
 * v1.19.1 — memory-error-classifier 單元測試
 *
 * 對應 openspec/changes/v1.19.1-secret-tool-routing/proposal.md §2.3 / spec.md 場景 10、11
 *
 * 從原本的 catch-all 500「更新／建立記憶失敗」黑盒、拆成依錯誤類別分流：
 *   - PG constraint violation (23xxx)：400 + 帶 hint
 *   - PG unique violation (23505)：409 + 帶 hint「資料重複」
 *   - PG connection exception (08xxx)：503 + 帶 hint「請稍候重試」
 *   - JS SyntaxError（JSON parse 等）：400
 *   - 其他未分類：500 + log stack（給除錯）
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

  it('not_null_violation (23502) → 400 + hint「欄位不可為空」', () => {
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

  it('unique_violation (23505) → 409 + hint「資料重複」', () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    const result = classifyMemoryError(err);
    assert.equal(result.status, 409);
    assert.ok(result.body.hint.includes('重複'));
  });
});

describe('classifyMemoryError — PG connection / 系統錯誤', () => {
  it('connection_exception (08000) → 503 + hint「請稍候重試」', () => {
    const err = Object.assign(new Error('connection refused'), { code: '08000' });
    const result = classifyMemoryError(err);
    assert.equal(result.status, 503);
    assert.ok(result.body.hint.includes('重試'));
    assert.equal(result.logStack, true, 'connection 錯誤要 log stack 給除錯');
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

describe('classifyMemoryError — JS 內建錯誤', () => {
  it('SyntaxError → 400「資料格式錯誤」', () => {
    const err = new SyntaxError('Unexpected token in JSON');
    const result = classifyMemoryError(err);
    assert.equal(result.status, 400);
    assert.ok(result.body.error.includes('格式'));
  });

  it('TypeError → 500（程式 bug、要 log stack）', () => {
    const err = new TypeError('Cannot read property foo of undefined');
    const result = classifyMemoryError(err);
    assert.equal(result.status, 500);
    assert.equal(result.logStack, true);
  });
});

describe('classifyMemoryError — 邊界與預設', () => {
  it('未分類 Error → 500 + log stack', () => {
    const err = new Error('something weird happened');
    const result = classifyMemoryError(err);
    assert.equal(result.status, 500);
    assert.equal(result.logStack, true);
    assert.ok(result.body.error.length > 0);
  });

  it('null → 500 fallback、不丟', () => {
    const result = classifyMemoryError(null);
    assert.equal(result.status, 500);
  });

  it('undefined → 500 fallback、不丟', () => {
    const result = classifyMemoryError(undefined);
    assert.equal(result.status, 500);
  });

  it('字串 → 500 fallback', () => {
    const result = classifyMemoryError('error message string');
    assert.equal(result.status, 500);
  });

  it('物件帶 status → 沿用 caller 給的 status', () => {
    const err = Object.assign(new Error('explicit 422'), { status: 422 });
    const result = classifyMemoryError(err);
    assert.equal(result.status, 422);
  });
});

describe('classifyMemoryError — 回傳結構', () => {
  it('body 必有 error 字串', () => {
    const result = classifyMemoryError(new Error('test'));
    assert.equal(typeof result.body.error, 'string');
    assert.ok(result.body.error.length > 0);
  });

  it('400 / 409 不 log stack（避免 noisy log）', () => {
    const constraint = Object.assign(new Error('constraint'), { code: '23514' });
    assert.equal(classifyMemoryError(constraint).logStack, false);

    const dup = Object.assign(new Error('dup'), { code: '23505' });
    assert.equal(classifyMemoryError(dup).logStack, false);
  });

  it('500 / 503 一律 log stack（給除錯）', () => {
    const conn = Object.assign(new Error('conn'), { code: '08000' });
    assert.equal(classifyMemoryError(conn).logStack, true);

    const generic = new Error('whatever');
    assert.equal(classifyMemoryError(generic).logStack, true);
  });

  it('logLevel：4xx 是 warn、5xx 是 error', () => {
    const constraint = Object.assign(new Error('c'), { code: '23514' });
    assert.equal(classifyMemoryError(constraint).logLevel, 'warn');

    const generic = new Error('g');
    assert.equal(classifyMemoryError(generic).logLevel, 'error');
  });
});

describe('classifyMemoryError — context 參數', () => {
  it('context=create → error 訊息含「建立」', () => {
    const result = classifyMemoryError(new Error('x'), { context: 'create' });
    assert.ok(result.body.error.includes('建立'));
  });

  it('context=update → error 訊息含「更新」', () => {
    const result = classifyMemoryError(new Error('x'), { context: 'update' });
    assert.ok(result.body.error.includes('更新'));
  });

  it('context 未傳 → 通用訊息「處理記憶失敗」', () => {
    const result = classifyMemoryError(new Error('x'));
    assert.ok(result.body.error.length > 0);
  });
});
