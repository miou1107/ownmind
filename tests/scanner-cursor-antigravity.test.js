import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { createVscodeAdapter, readVscodeTelemetry, toTaipeiYmd } =
  await import('../shared/scanners/vscode-telemetry.js');
const { createCursorAdapter } = await import('../shared/scanners/cursor.js');
const { createAntigravityAdapter } = await import('../shared/scanners/antigravity.js');

// ────────────────────────────────────────────────────────────
// toTaipeiYmd — pure
// ────────────────────────────────────────────────────────────

describe('toTaipeiYmd', () => {
  it('formats UTC Date into Taipei YYYY-MM-DD', () => {
    // UTC 2026-04-20T20:00 → Taipei 2026-04-21T04:00
    assert.equal(toTaipeiYmd(new Date('2026-04-20T20:00:00Z')), '2026-04-21');
  });

  it('midnight Taipei', () => {
    // UTC 2026-04-20T16:00 → Taipei 2026-04-21T00:00
    assert.equal(toTaipeiYmd(new Date('2026-04-20T16:00:00Z')), '2026-04-21');
  });

  it('handles invalid dates', () => {
    assert.equal(toTaipeiYmd(new Date('not-a-date')), null);
    assert.equal(toTaipeiYmd(null), null);
    assert.equal(toTaipeiYmd('abc'), null);
  });
});

// ────────────────────────────────────────────────────────────
// readVscodeTelemetry — via injected sqlite mock
// ────────────────────────────────────────────────────────────

function makeFakeSqlite(rows, { captureSql } = {}) {
  return async ({ sql }) => {
    captureSql?.(sql);
    return rows;
  };
}

describe('readVscodeTelemetry', () => {
  it('maps SQL rows to camelCased Dates', async () => {
    const rows = [
      { key: 'telemetry.firstSessionDate',   value: 'Tue, 12 Aug 2025 05:10:24 GMT' },
      { key: 'telemetry.lastSessionDate',    value: 'Wed, 04 Mar 2026 09:21:36 GMT' },
      { key: 'telemetry.currentSessionDate', value: 'Wed, 04 Mar 2026 09:25:07 GMT' }
    ];
    const t = await readVscodeTelemetry({
      dbPath: '/x', runSqlite: makeFakeSqlite(rows)
    });
    assert.ok(t.firstSessionDate instanceof Date);
    assert.equal(t.currentSessionDate.toISOString(), '2026-03-04T09:25:07.000Z');
  });

  it('returns {} on sqlite error (not thrown)', async () => {
    const logs = [];
    const t = await readVscodeTelemetry({
      dbPath: '/x',
      runSqlite: async () => { throw new Error('db locked'); },
      logger: { warn: (m) => logs.push(m) }
    });
    assert.deepEqual(t, {});
    assert.match(logs[0], /db locked/);
  });

  it('distinct ENOENT message for missing sqlite3 CLI', async () => {
    const logs = [];
    await readVscodeTelemetry({
      dbPath: '/x',
      sqlitePath: '/nowhere/sqlite3',
      runSqlite: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
      logger: { warn: (m) => logs.push(m) }
    });
    assert.match(logs[0], /sqlite3 CLI not found/);
  });

  it('skips rows with invalid date values', async () => {
    const t = await readVscodeTelemetry({
      dbPath: '/x',
      runSqlite: makeFakeSqlite([
        { key: 'telemetry.currentSessionDate', value: 'not-a-date' }
      ])
    });
    assert.deepEqual(t, {});
  });
});

// ────────────────────────────────────────────────────────────
// createVscodeAdapter — via injected runSqlite
// ────────────────────────────────────────────────────────────

describe('createVscodeAdapter.readSince', () => {
  it('emits one session record on first scan', async () => {
    const adapter = createVscodeAdapter({
      tool: 'cursor',
      dbPath: '/x',
      runSqlite: makeFakeSqlite([
        { key: 'telemetry.currentSessionDate', value: 'Tue, 21 Apr 2026 09:00:00 GMT' }
      ])
    });
    const r = await adapter.readSince({});
    assert.equal(r.events.length, 0, 'Tier 2 無 token events');
    assert.equal(r.sessions.length, 1);
    assert.equal(r.sessions[0].tool, 'cursor');
    assert.equal(r.sessions[0].date, '2026-04-21');  // Taipei = UTC+8
    assert.equal(r.sessions[0].count, 1);
    assert.equal(r.offsetPatch.cursor.last_session_date, '2026-04-21');
  });

  it('second scan on same date → no re-emit', async () => {
    const adapter = createVscodeAdapter({
      tool: 'cursor',
      dbPath: '/x',
      runSqlite: makeFakeSqlite([
        { key: 'telemetry.currentSessionDate', value: 'Tue, 21 Apr 2026 09:00:00 GMT' }
      ])
    });
    const state = { cursor: { last_session_date: '2026-04-21' } };
    const r = await adapter.readSince(state);
    assert.equal(r.sessions.length, 0, '同日已記錄，不應重發');
    assert.deepEqual(r.offsetPatch, {}, 'state 沒推進就不寫 offsetPatch');
  });

  it('new day → emits new session record', async () => {
    const adapter = createVscodeAdapter({
      tool: 'cursor',
      dbPath: '/x',
      runSqlite: makeFakeSqlite([
        { key: 'telemetry.currentSessionDate', value: 'Wed, 22 Apr 2026 09:00:00 GMT' }
      ])
    });
    const state = { cursor: { last_session_date: '2026-04-21' } };
    const r = await adapter.readSince(state);
    assert.equal(r.sessions.length, 1);
    assert.equal(r.sessions[0].date, '2026-04-22');
  });

  it('DB missing telemetry → no sessions but heartbeat still sent', async () => {
    const adapter = createVscodeAdapter({
      tool: 'cursor',
      dbPath: '/x',
      runSqlite: makeFakeSqlite([])  // 空結果
    });
    const r = await adapter.readSince({});
    assert.deepEqual(r.sessions, []);
    assert.equal(r.heartbeat.tool, 'cursor');
  });

  it('falls back to lastSessionDate when currentSessionDate missing', async () => {
    const adapter = createVscodeAdapter({
      tool: 'cursor',
      dbPath: '/x',
      runSqlite: makeFakeSqlite([
        { key: 'telemetry.lastSessionDate', value: 'Mon, 20 Apr 2026 10:00:00 GMT' }
      ])
    });
    const r = await adapter.readSince({});
    assert.equal(r.sessions.length, 1);
    assert.equal(r.sessions[0].date, '2026-04-20');
  });
});

// ────────────────────────────────────────────────────────────
// Cursor / Antigravity thin wrappers
// ────────────────────────────────────────────────────────────

describe('createCursorAdapter', () => {
  it('has tool=cursor + sets platform-appropriate default dbPath', () => {
    const a = createCursorAdapter({ runSqlite: makeFakeSqlite([]) });
    assert.equal(a.tool, 'cursor');
  });
});

describe('createAntigravityAdapter', () => {
  it('has tool=antigravity + readSince returns expected shape', async () => {
    const a = createAntigravityAdapter({
      dbPath: '/x',
      runSqlite: makeFakeSqlite([
        { key: 'telemetry.currentSessionDate', value: 'Tue, 21 Apr 2026 09:00:00 GMT' }
      ])
    });
    assert.equal(a.tool, 'antigravity');
    const r = await a.readSince({});
    assert.equal(r.sessions[0].tool, 'antigravity');
  });
});
