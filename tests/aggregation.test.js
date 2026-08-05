import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  computeTimeSpans, groupByModel, buildDailyRow,
  deriveTouchedCombos, recomputeDaily
} = await import('../src/jobs/usage-aggregation.js');

describe('computeTimeSpans', () => {
  it('returns zeros on empty input', () => {
    const r = computeTimeSpans([]);
    assert.equal(r.wall_seconds, 0);
    assert.equal(r.active_seconds, 0);
    assert.equal(r.first_ts, null);
    assert.equal(r.last_ts, null);
  });

  it('wall = last - first, active sums gaps <= threshold', () => {
    // t0, +30s, +60s, +900s (over 600s counts as offline), +120s
    const base = new Date('2026-04-21T09:00:00Z').getTime();
    const ts = [0, 30_000, 90_000, 990_000, 1_110_000].map((d) => new Date(base + d));
    const r = computeTimeSpans(ts, 600);
    // wall = 1110s
    assert.equal(r.wall_seconds, 1110);
    // active = 30 + 60 + 120 = 210 (900s gap is skipped)
    assert.equal(r.active_seconds, 210);
  });

  it('handles unsorted input', () => {
    const base = new Date('2026-04-21T09:00:00Z').getTime();
    const ts = [60_000, 0, 30_000].map((d) => new Date(base + d));
    const r = computeTimeSpans(ts, 600);
    assert.equal(r.wall_seconds, 60);
    assert.equal(r.active_seconds, 60);  // 30 + 30
  });

  it('single event → wall=0 active=0', () => {
    const r = computeTimeSpans([new Date()]);
    assert.equal(r.wall_seconds, 0);
    assert.equal(r.active_seconds, 0);
  });
});

describe('groupByModel', () => {
  it('aggregates tokens per model', () => {
    const events = [
      { model: 'opus', input_tokens: 10, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 0 },
      { model: 'opus', input_tokens: 5,  output_tokens: 5,  cache_creation_tokens: 100, cache_read_tokens: 0 },
      { model: 'sonnet', input_tokens: 1, output_tokens: 2, cache_creation_tokens: 0, cache_read_tokens: 50 }
    ];
    const m = groupByModel(events);
    assert.equal(m.size, 2);
    const opus = m.get('opus');
    assert.equal(opus.input_tokens, 15);
    assert.equal(opus.output_tokens, 25);
    assert.equal(opus.cache_creation_tokens, 100);
    assert.equal(opus.message_count, 2);
    const sonnet = m.get('sonnet');
    assert.equal(sonnet.message_count, 1);
    assert.equal(sonnet.cache_read_tokens, 50);
  });

  it('groups null model under __unknown__', () => {
    const events = [
      { model: null, input_tokens: 1, output_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0 },
      { model: undefined, input_tokens: 2, output_tokens: 2, cache_creation_tokens: 0, cache_read_tokens: 0 }
    ];
    const m = groupByModel(events);
    assert.equal(m.size, 1);
    assert.equal(m.get('__unknown__').message_count, 2);
    assert.equal(m.get('__unknown__').input_tokens, 3);
  });
});

describe('buildDailyRow', () => {
  const pricingRows = [
    { id: 1, tool: 'claude-code', model: 'opus',
      input_per_1m: 15, output_per_1m: 75, cache_write_per_1m: 18.75, cache_read_per_1m: 1.5,
      effective_date: '2024-01-01' },
    { id: 2, tool: 'claude-code', model: 'sonnet',
      input_per_1m: 3, output_per_1m: 15, cache_write_per_1m: 3.75, cache_read_per_1m: 0.3,
      effective_date: '2024-01-01' }
  ];

  it('sums totals across multiple models, and never a cost', () => {
    const events = [
      { model: 'opus', ts: '2026-04-21T09:00:00Z',
        input_tokens: 1_000_000, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
      { model: 'sonnet', ts: '2026-04-21T09:05:00Z',
        input_tokens: 0, output_tokens: 1_000_000, cache_creation_tokens: 0, cache_read_tokens: 0 }
    ];
    const row = buildDailyRow(
      { user_id: 1, tool: 'claude-code', session_id: 's1', date: '2026-04-21' },
      events
    );
    assert.equal(row.input_tokens, 1_000_000);
    assert.equal(row.output_tokens, 1_000_000);
    assert.equal(row.message_count, 2);
    // latestModel uses the model of the latest ts
    assert.equal(row.model, 'sonnet');
    // v1.26.60: this used to assert 30 USD. Requirement 8 removed the calculation
    // rather than fixing it, so the column is written NULL from here on.
    assert.equal(row.cost_usd, null);
  });

  it('a third argument is ignored, so leftover pricing rows cannot resurrect a cost', () => {
    // Guards the deletion rather than the arithmetic: a caller still passing pricing
    // must not get a number back, because nothing downstream expects one any more.
    const events = [
      { model: 'opus', ts: '2026-04-21T09:00:00Z',
        input_tokens: 1_000_000, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 }
    ];
    const row = buildDailyRow(
      { user_id: 1, tool: 'claude-code', session_id: 's1', date: '2026-04-21' },
      events, pricingRows
    );
    assert.equal(row.cost_usd, null);
  });

  it('returns cost_usd=null when known + unknown models mix (not partial cost)', () => {
    const events = [
      { model: 'opus', ts: '2026-04-21T09:00:00Z',
        input_tokens: 1_000_000, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
      { model: 'mystery', ts: '2026-04-21T09:30:00Z',
        input_tokens: 1_000, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 }
    ];
    const row = buildDailyRow(
      { user_id: 1, tool: 'claude-code', session_id: 's1', date: '2026-04-21' },
      events, pricingRows
    );
    // Policy: partial cost is more dangerous than null; any unknown pricing → whole row null
    assert.equal(row.cost_usd, null);
    // tokens are still counted
    assert.equal(row.input_tokens, 1_001_000);
  });

  it('is idempotent — same input yields same output', () => {
    const events = [
      { model: 'opus', ts: '2026-04-21T09:00:00Z',
        input_tokens: 1_000, output_tokens: 500, cache_creation_tokens: 0, cache_read_tokens: 0 }
    ];
    const a = buildDailyRow(
      { user_id: 1, tool: 'claude-code', session_id: 's1', date: '2026-04-21' },
      events, pricingRows);
    const b = buildDailyRow(
      { user_id: 1, tool: 'claude-code', session_id: 's1', date: '2026-04-21' },
      events, pricingRows);
    assert.deepEqual(a, b);
  });

  it('computes active_seconds respecting 600s gap threshold', () => {
    const events = [
      { model: 'opus', ts: '2026-04-21T09:00:00Z',
        input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
      { model: 'opus', ts: '2026-04-21T09:05:00Z',  // +300s
        input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
      { model: 'opus', ts: '2026-04-21T09:30:00Z',  // +1500s (over threshold)
        input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 }
    ];
    const row = buildDailyRow(
      { user_id: 1, tool: 'claude-code', session_id: 's1', date: '2026-04-21' },
      events, pricingRows);
    assert.equal(row.wall_seconds, 1800);    // 30 min
    assert.equal(row.active_seconds, 300);   // only the first segment counts
  });
});

describe('deriveTouchedCombos', () => {
  it('dedupes combos and converts ts to Asia/Taipei date', () => {
    const events = [
      { tool: 'claude-code', session_id: 's1', ts: '2026-04-21T01:00:00Z' },  // Taiwan 09:00
      { tool: 'claude-code', session_id: 's1', ts: '2026-04-21T10:00:00Z' },  // Taiwan 18:00
      { tool: 'codex',       session_id: 's2', ts: '2026-04-21T16:30:00Z' },  // Taiwan 00:30 → 2026-04-22
      { tool: 'claude-code', session_id: 's1', ts: '2026-04-20T15:30:00Z' }   // Taiwan 23:30 → 2026-04-20
    ];
    const combos = deriveTouchedCombos(events);
    const set = new Set(combos.map((c) => `${c.tool}::${c.session_id}::${c.date}`));
    assert.ok(set.has('claude-code::s1::2026-04-21'));
    assert.ok(set.has('codex::s2::2026-04-22'));
    assert.ok(set.has('claude-code::s1::2026-04-20'));
    assert.equal(combos.length, 3);  // 2026-04-21 duplicate is deduped
  });
});

describe('recomputeDaily — DB integration via injected query', () => {
  it('queries events and UPSERTs the daily row, without ever asking for pricing', async () => {
    const calls = [];
    const fakeQuery = async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM token_events\s+WHERE/.test(sql)) {
        return {
          rows: [
            { model: 'opus', ts: '2026-04-21T09:00:00Z',
              input_tokens: 1_000_000, output_tokens: 0,
              cache_creation_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0 }
          ]
        };
      }
      if (/INSERT INTO token_usage_daily/.test(sql)) {
        return { rowCount: 1 };
      }
      throw new Error('unexpected SQL: ' + sql);
    };

    const result = await recomputeDaily(
      { query: fakeQuery },
      { userId: 1, tool: 'claude-code', sessionId: 's1', date: '2026-04-21' }
    );

    assert.ok(result.row);
    assert.equal(result.row.input_tokens, 1_000_000);
    // v1.26.60: no pricing lookup happens at all now, so the fake query above throws on
    // one — which is the assertion. The cost written is NULL.
    assert.equal(result.row.cost_usd, null);
    assert.equal(calls.filter((c) => /model_pricing/.test(c.sql)).length, 0,
      'the aggregation job must not read the pricing table any more');
    // Check UPSERT was called with correct params
    const upsert = calls.find((c) => /INSERT INTO token_usage_daily/.test(c.sql));
    assert.ok(upsert, 'UPSERT 應該被呼叫');
    assert.equal(upsert.params[0], 1);                   // user_id
    assert.equal(upsert.params[2], 's1');                // session_id
    assert.equal(upsert.params[3], '2026-04-21');        // date
  });

  it('the UPSERT never overwrites an existing cost_usd', async () => {
    // Found in adversarial review of v1.26.60. Cost stopped being computed, so the value
    // bound into the statement is always NULL — and nightly-recompute.js re-runs the last
    // seven days every night while ingestion re-runs any day that receives new events. An
    // `ON CONFLICT ... cost_usd = EXCLUDED.cost_usd` would therefore have blanked a
    // rolling window of historical values on the first night, which is the opposite of
    // what this release documented.
    let upsertSql = '';
    const fakeQuery = async (sql) => {
      if (/FROM token_events\s+WHERE/.test(sql)) {
        return { rows: [{ model: 'opus', ts: '2026-04-21T09:00:00Z',
          input_tokens: 10, output_tokens: 0,
          cache_creation_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0 }] };
      }
      if (/INSERT INTO token_usage_daily/.test(sql)) { upsertSql = sql; return { rowCount: 1 }; }
      throw new Error('unexpected SQL: ' + sql);
    };
    await recomputeDaily(
      { query: fakeQuery },
      { userId: 1, tool: 'claude-code', sessionId: 's1', date: '2026-04-21' }
    );
    const doUpdate = upsertSql.slice(upsertSql.indexOf('DO UPDATE'));
    assert.doesNotMatch(
      doUpdate.replace(/--[^\n]*/g, ''),
      /cost_usd\s*=/,
      'DO UPDATE must leave cost_usd alone; assigning it erases historical values',
    );
    // But a brand-new row still carries the column, written NULL.
    assert.match(upsertSql.slice(0, upsertSql.indexOf('DO UPDATE')), /cost_usd/);
  });

  it('skips UPSERT when no events exist', async () => {
    const calls = [];
    const fakeQuery = async (sql, params) => {
      calls.push({ sql });
      if (/FROM token_events/.test(sql)) return { rows: [] };
      throw new Error('should not query pricing or UPSERT');
    };
    const result = await recomputeDaily(
      { query: fakeQuery },
      { userId: 1, tool: 'claude-code', sessionId: 's1', date: '2026-04-21' }
    );
    assert.equal(result.skipped, true);
    assert.equal(calls.length, 1);
  });
});
