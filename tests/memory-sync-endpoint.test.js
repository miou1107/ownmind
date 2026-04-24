import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  SYNCABLE_TYPES,
  parseSyncTypes,
  parseSince,
  buildSyncQuery,
} = await import('../src/lib/memory-sync.js');

describe('parseSyncTypes', () => {
  it('undefined 回傳預設 3 類', () => {
    const r = parseSyncTypes(undefined);
    assert.deepEqual(r, { ok: true, types: SYNCABLE_TYPES });
  });

  it('空字串回傳預設', () => {
    const r = parseSyncTypes('');
    assert.equal(r.ok, true);
    assert.deepEqual(r.types, SYNCABLE_TYPES);
  });

  it('合法 types 保留', () => {
    const r = parseSyncTypes('iron_rule,project');
    assert.deepEqual(r, { ok: true, types: ['iron_rule', 'project'] });
  });

  it('容忍空白', () => {
    const r = parseSyncTypes(' iron_rule , feedback ');
    assert.deepEqual(r, { ok: true, types: ['iron_rule', 'feedback'] });
  });

  it('不允許的類型拒 400', () => {
    const r = parseSyncTypes('iron_rule,profile');
    assert.equal(r.ok, false);
    assert.match(r.error, /profile/);
  });

  it('完全不合法拒 400', () => {
    const r = parseSyncTypes('garbage');
    assert.equal(r.ok, false);
  });

  it('SYNCABLE_TYPES 內容為 iron_rule/project/feedback', () => {
    assert.deepEqual([...SYNCABLE_TYPES].sort(), ['feedback', 'iron_rule', 'project']);
  });
});

describe('parseSince', () => {
  it('undefined → null', () => {
    assert.deepEqual(parseSince(undefined), { ok: true, since: null });
  });

  it('空字串 → null', () => {
    assert.deepEqual(parseSince(''), { ok: true, since: null });
  });

  it('合法 ISO8601 → Date', () => {
    const r = parseSince('2026-04-20T10:00:00Z');
    assert.equal(r.ok, true);
    assert.ok(r.since instanceof Date);
    assert.equal(r.since.toISOString(), '2026-04-20T10:00:00.000Z');
  });

  it('亂字串拒', () => {
    const r = parseSince('not-a-date');
    assert.equal(r.ok, false);
  });
});

describe('buildSyncQuery', () => {
  it('無 since → 只撈 active', () => {
    const q = buildSyncQuery(1, ['iron_rule'], null);
    assert.match(q.text, /status = 'active'/);
    assert.doesNotMatch(q.text, /disabled_at/);
    assert.deepEqual(q.values, [1, ['iron_rule']]);
  });

  it('有 since → 撈 updated_at > since OR disabled_at > since', () => {
    const d = new Date('2026-04-20T00:00:00Z');
    const q = buildSyncQuery(2, ['project', 'feedback'], d);
    assert.match(q.text, /updated_at > \$3/);
    assert.match(q.text, /disabled_at/);
    assert.doesNotMatch(q.text, /status = 'active'/);
    assert.deepEqual(q.values, [2, ['project', 'feedback'], d]);
  });

  it('有 since 時不硬擋 status — disabled 也要能 tombstone 回傳', () => {
    const d = new Date();
    const q = buildSyncQuery(1, ['iron_rule'], d);
    // 只要 WHERE 中不含 "status = 'active'" 就對了
    assert.doesNotMatch(q.text, /status\s*=\s*'active'/);
  });

  it('只 SELECT 同步需要的欄位', () => {
    const q = buildSyncQuery(1, ['iron_rule'], null);
    for (const col of ['id', 'type', 'title', 'content', 'tags', 'metadata', 'updated_at', 'status']) {
      assert.match(q.text, new RegExp(`\\b${col}\\b`));
    }
  });

  it('用 ANY($2::text[]) 避免 SQL 注入', () => {
    const q = buildSyncQuery(1, ['iron_rule'], null);
    assert.match(q.text, /ANY\(\$2::text\[\]\)/);
  });
});
