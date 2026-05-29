import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  SYNCABLE_TYPES,
  parseSyncTypes,
  parseSince,
  buildSyncQuery,
} = await import('../src/lib/memory-sync.js');

describe('parseSyncTypes', () => {
  it('undefined returns the default 3 types', () => {
    const r = parseSyncTypes(undefined);
    assert.deepEqual(r, { ok: true, types: SYNCABLE_TYPES });
  });

  it('empty string returns the default', () => {
    const r = parseSyncTypes('');
    assert.equal(r.ok, true);
    assert.deepEqual(r.types, SYNCABLE_TYPES);
  });

  it('keeps valid types', () => {
    const r = parseSyncTypes('iron_rule,project');
    assert.deepEqual(r, { ok: true, types: ['iron_rule', 'project'] });
  });

  it('tolerates whitespace', () => {
    const r = parseSyncTypes(' iron_rule , feedback ');
    assert.deepEqual(r, { ok: true, types: ['iron_rule', 'feedback'] });
  });

  it('rejects disallowed types with 400', () => {
    const r = parseSyncTypes('iron_rule,profile');
    assert.equal(r.ok, false);
    assert.match(r.error, /profile/);
  });

  it('rejects fully invalid input with 400', () => {
    const r = parseSyncTypes('garbage');
    assert.equal(r.ok, false);
  });

  it('SYNCABLE_TYPES contains iron_rule/project/feedback', () => {
    assert.deepEqual([...SYNCABLE_TYPES].sort(), ['feedback', 'iron_rule', 'project']);
  });
});

describe('parseSince', () => {
  it('undefined → null', () => {
    assert.deepEqual(parseSince(undefined), { ok: true, since: null });
  });

  it('empty string → null', () => {
    assert.deepEqual(parseSince(''), { ok: true, since: null });
  });

  it('valid ISO8601 → Date', () => {
    const r = parseSince('2026-04-20T10:00:00Z');
    assert.equal(r.ok, true);
    assert.ok(r.since instanceof Date);
    assert.equal(r.since.toISOString(), '2026-04-20T10:00:00.000Z');
  });

  it('rejects garbage string', () => {
    const r = parseSince('not-a-date');
    assert.equal(r.ok, false);
  });
});

describe('buildSyncQuery', () => {
  it('no since → only fetch active', () => {
    const q = buildSyncQuery(1, ['iron_rule'], null);
    assert.match(q.text, /status = 'active'/);
    assert.doesNotMatch(q.text, /disabled_at/);
    assert.deepEqual(q.values, [1, ['iron_rule']]);
  });

  it('with since → fetch updated_at > since OR disabled_at > since', () => {
    const d = new Date('2026-04-20T00:00:00Z');
    const q = buildSyncQuery(2, ['project', 'feedback'], d);
    assert.match(q.text, /updated_at > \$3/);
    assert.match(q.text, /disabled_at/);
    assert.doesNotMatch(q.text, /status = 'active'/);
    assert.deepEqual(q.values, [2, ['project', 'feedback'], d]);
  });

  it('with since does not hard-filter status — disabled must also be returned as tombstone', () => {
    const d = new Date();
    const q = buildSyncQuery(1, ['iron_rule'], d);
    // As long as WHERE does not contain "status = 'active'" it is correct
    assert.doesNotMatch(q.text, /status\s*=\s*'active'/);
  });

  it('only SELECTs the columns needed for sync', () => {
    const q = buildSyncQuery(1, ['iron_rule'], null);
    for (const col of ['id', 'type', 'title', 'content', 'tags', 'metadata', 'updated_at', 'status']) {
      assert.match(q.text, new RegExp(`\\b${col}\\b`));
    }
  });

  it('uses ANY($2::text[]) to avoid SQL injection', () => {
    const q = buildSyncQuery(1, ['iron_rule'], null);
    assert.match(q.text, /ANY\(\$2::text\[\]\)/);
  });
});
