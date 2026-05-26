import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { requireFields } = await import('../src/utils/require-fields.js');

describe('requireFields — basic behavior', () => {
  it('all fields supplied → passes (returns null)', () => {
    const result = requireFields(
      { tool: 'claude-code', model: 'opus-4-7', summary: 'test' },
      ['tool', 'model', 'summary']
    );
    assert.equal(result, null);
  });

  it('all fields missing → missing lists every field, received is empty object', () => {
    const result = requireFields({}, ['tool', 'model', 'summary']);
    assert.equal(result.error, '必填欄位缺少');
    assert.deepEqual(result.missing, ['tool', 'model', 'summary']);
    assert.deepEqual(result.expected, ['tool', 'model', 'summary']);
    assert.deepEqual(result.received, {});
  });

  it('some missing → missing lists only the absent ones, received has the provided fields', () => {
    const result = requireFields(
      { summary: 'test' },
      ['tool', 'model', 'summary']
    );
    assert.deepEqual(result.missing, ['tool', 'model']);
    assert.deepEqual(result.received, { summary: 'test' });
  });
});

describe('requireFields — boundary values', () => {
  it('body=null is handled safely (no throw, treated as all missing)', () => {
    const result = requireFields(null, ['x', 'y']);
    assert.deepEqual(result.missing, ['x', 'y']);
    assert.deepEqual(result.received, {});
  });

  it('body=undefined is handled safely', () => {
    const result = requireFields(undefined, ['x']);
    assert.deepEqual(result.missing, ['x']);
  });

  it('non-object body (string) is handled safely', () => {
    const result = requireFields('not an object', ['x']);
    assert.deepEqual(result.missing, ['x']);
    assert.deepEqual(result.received, {});
  });

  it('empty string counts as missing', () => {
    const result = requireFields({ tool: '' }, ['tool']);
    assert.deepEqual(result.missing, ['tool']);
  });

  it('null counts as missing', () => {
    const result = requireFields({ tool: null }, ['tool']);
    assert.deepEqual(result.missing, ['tool']);
  });

  it('undefined counts as missing', () => {
    const result = requireFields({ tool: undefined }, ['tool']);
    assert.deepEqual(result.missing, ['tool']);
  });

  it('empty array counts as missing (for memory.js chunks)', () => {
    const result = requireFields({ chunks: [] }, ['chunks']);
    assert.deepEqual(result.missing, ['chunks']);
  });

  it('non-empty array passes', () => {
    const result = requireFields({ chunks: [{ a: 1 }] }, ['chunks']);
    assert.equal(result, null);
  });

  it('the number 0 passes (valid value)', () => {
    const result = requireFields({ count: 0 }, ['count']);
    assert.equal(result, null);
  });

  it('false passes (valid value)', () => {
    const result = requireFields({ enabled: false }, ['enabled']);
    assert.equal(result, null);
  });
});

describe('requireFields — sensitive-field redaction (security-critical)', () => {
  it('redacts value by default (used by secret.js)', () => {
    const result = requireFields(
      { value: 'my-secret-token-12345' },
      ['key', 'value']
    );
    assert.deepEqual(result.missing, ['key']);
    assert.equal(result.received.value, '<REDACTED>');
  });

  it('redacts password by default', () => {
    const result = requireFields(
      { username: 'vin', password: 'p4ssw0rd' },
      ['username', 'email']
    );
    assert.equal(result.received.username, 'vin');
    assert.equal(result.received.password, '<REDACTED>');
  });

  it('redacts token / api_key / secret by default', () => {
    const result = requireFields(
      { token: 'abc', api_key: 'def', secret: 'ghi', other: 'jkl' },
      ['needed']
    );
    assert.equal(result.received.token, '<REDACTED>');
    assert.equal(result.received.api_key, '<REDACTED>');
    assert.equal(result.received.secret, '<REDACTED>');
    assert.equal(result.received.other, 'jkl');
  });

  it('redaction is case-insensitive', () => {
    const result = requireFields(
      { TOKEN: 'abc', Password: 'def' },
      ['needed']
    );
    assert.equal(result.received.TOKEN, '<REDACTED>');
    assert.equal(result.received.Password, '<REDACTED>');
  });

  it('custom sensitiveKeys can be merged in', () => {
    const result = requireFields(
      { custom_field: 'sensitive' },
      ['needed'],
      { sensitiveKeys: ['custom_field'] }
    );
    assert.equal(result.received.custom_field, '<REDACTED>');
  });
});
