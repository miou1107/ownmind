// v1.26.56 — the bar and daily charts' presentation math, extracted so the
// division is executed by a test rather than eyeballed in JSX.
//
// The legacy renderBarChart divided by `Math.max(...values, 1)`. That guard is
// load-bearing: without it an all-zero distribution divides by zero and puts
// `NaN%` into a style attribute, which silently renders a full-width bar in
// some browsers. Kept, and pinned here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { barChartRows, dailyChartRows } from '../client/src/pages/Team/stats-chart-data.js';

describe('barChartRows', () => {
  it('is proportional to the largest value', () => {
    const rows = barChartRows({ a: 5, b: 10 });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.pct]));
    assert.equal(byKey.b, 100);
    assert.equal(byKey.a, 50);
  });

  it('orders by count descending', () => {
    assert.deepEqual(barChartRows({ a: 1, b: 9, c: 4 }).map((r) => r.key), ['b', 'c', 'a']);
  });

  it('an empty distribution yields no rows', () => {
    assert.deepEqual(barChartRows({}), []);
    assert.deepEqual(barChartRows(null), []);
    assert.deepEqual(barChartRows(undefined), []);
  });

  it('all-zero values produce 0% and never NaN', () => {
    const rows = barChartRows({ a: 0, b: 0 });
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.pct, 0);
      assert.ok(Number.isFinite(r.pct), `pct must be finite, got ${r.pct}`);
    }
  });

  it('carries the raw count through for the number beside the bar', () => {
    assert.deepEqual(barChartRows({ a: 3 }), [{ key: 'a', count: 3, pct: 100 }]);
  });

  it('accepts the string counts pg returns', () => {
    const rows = barChartRows({ a: '2', b: '8' });
    assert.deepEqual(rows.map((r) => r.count), [8, 2]);
    assert.deepEqual(rows.map((r) => r.pct), [100, 25]);
  });
});

describe('dailyChartRows', () => {
  it('keeps chronological order rather than sorting by count', () => {
    // The daily chart is a time series: reordering it by size would be a lie.
    const rows = dailyChartRows([
      { date: '2026-08-01', count: 9 },
      { date: '2026-08-02', count: 1 },
      { date: '2026-08-03', count: 5 },
    ]);
    assert.deepEqual(rows.map((r) => r.date), ['2026-08-01', '2026-08-02', '2026-08-03']);
  });

  it('is proportional to the busiest day', () => {
    const rows = dailyChartRows([
      { date: '2026-08-01', count: 5 },
      { date: '2026-08-02', count: 10 },
    ]);
    assert.deepEqual(rows.map((r) => r.pct), [50, 100]);
  });

  it('an empty series yields no rows', () => {
    assert.deepEqual(dailyChartRows([]), []);
    assert.deepEqual(dailyChartRows(null), []);
  });

  it('an all-zero series produces 0% and never NaN', () => {
    const rows = dailyChartRows([{ date: '2026-08-01', count: 0 }]);
    assert.equal(rows[0].pct, 0);
    assert.ok(Number.isFinite(rows[0].pct));
  });
});
