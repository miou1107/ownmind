import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { requireFields } = await import('../src/utils/require-fields.js');

describe('requireFields — 基本行為', () => {
  it('全部給 → 通過（回 null）', () => {
    const result = requireFields(
      { tool: 'claude-code', model: 'opus-4-7', summary: 'test' },
      ['tool', 'model', 'summary']
    );
    assert.equal(result, null);
  });

  it('缺所有 → missing 含全部、received 為空物件', () => {
    const result = requireFields({}, ['tool', 'model', 'summary']);
    assert.equal(result.error, '必填欄位缺少');
    assert.deepEqual(result.missing, ['tool', 'model', 'summary']);
    assert.deepEqual(result.expected, ['tool', 'model', 'summary']);
    assert.deepEqual(result.received, {});
  });

  it('缺部分 → missing 只列缺的、received 含已傳欄位', () => {
    const result = requireFields(
      { summary: 'test' },
      ['tool', 'model', 'summary']
    );
    assert.deepEqual(result.missing, ['tool', 'model']);
    assert.deepEqual(result.received, { summary: 'test' });
  });
});

describe('requireFields — 邊界值', () => {
  it('body=null 安全處理（不 throw、視為全缺）', () => {
    const result = requireFields(null, ['x', 'y']);
    assert.deepEqual(result.missing, ['x', 'y']);
    assert.deepEqual(result.received, {});
  });

  it('body=undefined 安全處理', () => {
    const result = requireFields(undefined, ['x']);
    assert.deepEqual(result.missing, ['x']);
  });

  it('body 非物件（字串）安全處理', () => {
    const result = requireFields('not an object', ['x']);
    assert.deepEqual(result.missing, ['x']);
    assert.deepEqual(result.received, {});
  });

  it('空字串視為缺', () => {
    const result = requireFields({ tool: '' }, ['tool']);
    assert.deepEqual(result.missing, ['tool']);
  });

  it('null 視為缺', () => {
    const result = requireFields({ tool: null }, ['tool']);
    assert.deepEqual(result.missing, ['tool']);
  });

  it('undefined 視為缺', () => {
    const result = requireFields({ tool: undefined }, ['tool']);
    assert.deepEqual(result.missing, ['tool']);
  });

  it('空陣列視為缺（給 memory.js chunks 用）', () => {
    const result = requireFields({ chunks: [] }, ['chunks']);
    assert.deepEqual(result.missing, ['chunks']);
  });

  it('非空陣列通過', () => {
    const result = requireFields({ chunks: [{ a: 1 }] }, ['chunks']);
    assert.equal(result, null);
  });

  it('數字 0 通過（合法值）', () => {
    const result = requireFields({ count: 0 }, ['count']);
    assert.equal(result, null);
  });

  it('false 通過（合法值）', () => {
    const result = requireFields({ enabled: false }, ['enabled']);
    assert.equal(result, null);
  });
});

describe('requireFields — 敏感欄位遮蔽（安全關鍵）', () => {
  it('預設遮蔽 value（secret.js 用）', () => {
    const result = requireFields(
      { value: 'my-secret-token-12345' },
      ['key', 'value']
    );
    assert.deepEqual(result.missing, ['key']);
    assert.equal(result.received.value, '<REDACTED>');
  });

  it('預設遮蔽 password', () => {
    const result = requireFields(
      { username: 'vin', password: 'p4ssw0rd' },
      ['username', 'email']
    );
    assert.equal(result.received.username, 'vin');
    assert.equal(result.received.password, '<REDACTED>');
  });

  it('預設遮蔽 token / api_key / secret', () => {
    const result = requireFields(
      { token: 'abc', api_key: 'def', secret: 'ghi', other: 'jkl' },
      ['needed']
    );
    assert.equal(result.received.token, '<REDACTED>');
    assert.equal(result.received.api_key, '<REDACTED>');
    assert.equal(result.received.secret, '<REDACTED>');
    assert.equal(result.received.other, 'jkl');
  });

  it('遮蔽大小寫不敏感', () => {
    const result = requireFields(
      { TOKEN: 'abc', Password: 'def' },
      ['needed']
    );
    assert.equal(result.received.TOKEN, '<REDACTED>');
    assert.equal(result.received.Password, '<REDACTED>');
  });

  it('自訂 sensitiveKeys 可疊加', () => {
    const result = requireFields(
      { custom_field: 'sensitive' },
      ['needed'],
      { sensitiveKeys: ['custom_field'] }
    );
    assert.equal(result.received.custom_field, '<REDACTED>');
  });
});
