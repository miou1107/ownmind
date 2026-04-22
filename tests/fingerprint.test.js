import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  canonicalizeCodexMaterial, codexMessageId, materialsEqual, CODEX_MATERIAL_KEYS
} = await import('../shared/scanners/id-helper.js');

const fullMaterial = {
  ts_iso: '2026-04-21T09:00:00+08:00',
  total_cumulative: 60521,
  last_total: 1169,
  input: 6,
  output: 1163,
  cache_creation: 59352,
  cache_read: 0,
  reasoning: 0
};

describe('canonicalizeCodexMaterial', () => {
  it('normalizes ts_iso to ISO 8601 UTC millisecond precision', () => {
    const a = canonicalizeCodexMaterial({ ...fullMaterial, ts_iso: '2026-04-21T09:00:00+08:00' });
    const b = canonicalizeCodexMaterial({ ...fullMaterial, ts_iso: '2026-04-21T01:00:00.000Z' });
    assert.equal(a.ts_iso, b.ts_iso, '不同格式同一瞬間應 canonicalize 成同字串');
    assert.match(a.ts_iso, /\.\d{3}Z$/);
  });

  it('null / undefined numeric fields → 0', () => {
    const m = canonicalizeCodexMaterial({
      ts_iso: '2026-04-21T01:00:00Z',
      total_cumulative: null, last_total: undefined,
      input: 10, output: 5,
      cache_creation: null, cache_read: undefined, reasoning: 0
    });
    assert.equal(m.total_cumulative, 0);
    assert.equal(m.last_total, 0);
    assert.equal(m.cache_creation, 0);
    assert.equal(m.cache_read, 0);
  });

  it('missing ts_iso throws', () => {
    assert.throws(() => canonicalizeCodexMaterial({ ...fullMaterial, ts_iso: undefined }),
      /missing required ts_iso/);
  });

  it('non-finite number throws', () => {
    assert.throws(() => canonicalizeCodexMaterial({ ...fullMaterial, input: NaN }),
      /invalid input/);
    assert.throws(() => canonicalizeCodexMaterial({ ...fullMaterial, input: 'abc' }),
      /invalid input/);
  });

  it('invalid ts_iso throws', () => {
    assert.throws(() => canonicalizeCodexMaterial({ ...fullMaterial, ts_iso: 'not-a-date' }),
      /invalid ts_iso/);
  });

  it('truncates decimals', () => {
    const m = canonicalizeCodexMaterial({ ...fullMaterial, input: 6.9 });
    assert.equal(m.input, 6);
  });

  it('throws on non-object input', () => {
    assert.throws(() => canonicalizeCodexMaterial(null), /must be an object/);
    assert.throws(() => canonicalizeCodexMaterial('hi'), /must be an object/);
  });

  it('CODEX_MATERIAL_KEYS covers all required fields', () => {
    assert.deepEqual(CODEX_MATERIAL_KEYS, [
      'ts_iso', 'total_cumulative', 'last_total',
      'input', 'output', 'cache_creation', 'cache_read', 'reasoning'
    ]);
  });
});

describe('codexMessageId', () => {
  it('produces full 64-hex sha256 (not truncated)', () => {
    const m = canonicalizeCodexMaterial(fullMaterial);
    const id = codexMessageId('sess-1', m);
    assert.equal(id.length, 64);
    assert.match(id, /^[a-f0-9]{64}$/);
  });

  it('same canonical material → same id (deterministic)', () => {
    const m = canonicalizeCodexMaterial(fullMaterial);
    assert.equal(codexMessageId('s1', m), codexMessageId('s1', m));
  });

  it('differing any token field → different id', () => {
    const base = canonicalizeCodexMaterial(fullMaterial);
    const fields = ['total_cumulative', 'last_total', 'input', 'output',
                    'cache_creation', 'cache_read', 'reasoning'];
    const ids = fields.map((f) =>
      codexMessageId('s1', canonicalizeCodexMaterial({ ...fullMaterial, [f]: fullMaterial[f] + 1 }))
    );
    const baseId = codexMessageId('s1', base);
    for (const id of ids) assert.notEqual(id, baseId, `change to ${id.slice(0, 8)} should flip id`);
    assert.equal(new Set([...ids, baseId]).size, fields.length + 1, '每個 field 改動都要產不同 id');
  });

  it('differing session_id → different id', () => {
    const m = canonicalizeCodexMaterial(fullMaterial);
    assert.notEqual(codexMessageId('s1', m), codexMessageId('s2', m));
  });

  it('cache_creation distinction catches the schema-coverage issue', () => {
    // 兩筆只差 cache_creation → 必須不同 id（否則會被誤 dedupe）
    const a = canonicalizeCodexMaterial({ ...fullMaterial, cache_creation: 100 });
    const b = canonicalizeCodexMaterial({ ...fullMaterial, cache_creation: 200 });
    assert.notEqual(codexMessageId('s1', a), codexMessageId('s1', b));
  });

  it('different timestamp formats same instant → same id (through canonicalize)', () => {
    const a = canonicalizeCodexMaterial({ ...fullMaterial, ts_iso: '2026-04-21T09:00:00+08:00' });
    const b = canonicalizeCodexMaterial({ ...fullMaterial, ts_iso: '2026-04-21T01:00:00Z' });
    assert.equal(codexMessageId('s1', a), codexMessageId('s1', b));
  });

  it('throws without sessionId', () => {
    const m = canonicalizeCodexMaterial(fullMaterial);
    assert.throws(() => codexMessageId('', m), /sessionId required/);
    assert.throws(() => codexMessageId(null, m), /sessionId required/);
  });
});

describe('materialsEqual', () => {
  it('equal when all canonical keys match', () => {
    const a = canonicalizeCodexMaterial(fullMaterial);
    const b = canonicalizeCodexMaterial(fullMaterial);
    assert.equal(materialsEqual(a, b), true);
  });

  it('unequal when any key differs', () => {
    const a = canonicalizeCodexMaterial(fullMaterial);
    const b = canonicalizeCodexMaterial({ ...fullMaterial, input: fullMaterial.input + 1 });
    assert.equal(materialsEqual(a, b), false);
  });

  it('null-safe on either side', () => {
    assert.equal(materialsEqual(null, {}), false);
    assert.equal(materialsEqual({}, null), false);
  });
});
