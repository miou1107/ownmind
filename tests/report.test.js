import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePeriodRange, groupFrictions, computeReportData } from '../src/utils/report.js';

describe('computePeriodRange', () => {
  it('week offset=0 returns this week Mon–Sun (label check)', () => {
    // 2026-03-25 is a Wednesday
    const now = new Date('2026-03-25T12:00:00+08:00');
    const { label } = computePeriodRange('week', 0, now);
    assert.equal(label, '2026-03-23 ~ 2026-03-29');
  });

  it('week offset=1 returns last week', () => {
    const now = new Date('2026-03-25T12:00:00+08:00');
    const { label } = computePeriodRange('week', 1, now);
    assert.equal(label, '2026-03-16 ~ 2026-03-22');
  });

  it('month offset=0 returns this month', () => {
    const now = new Date('2026-03-15T12:00:00+08:00');
    const { label } = computePeriodRange('month', 0, now);
    assert.equal(label, '2026-03-01 ~ 2026-03-31');
  });

  it('week start/end times correct (UTC+8 Monday 00:00 ~ Sunday 23:59)', () => {
    const now = new Date('2026-03-25T12:00:00+08:00');
    const { start, end } = computePeriodRange('week', 0, now);
    // Monday 00:00 Asia/Taipei = Sunday 16:00 UTC
    assert.equal(start.toISOString(), '2026-03-22T16:00:00.000Z');
    // Sunday 23:59:59.999 Asia/Taipei = Sunday 15:59:59.999 UTC
    assert.equal(end.toISOString(), '2026-03-29T15:59:59.999Z');
  });

  it('unknown period throws', () => {
    assert.throws(() => computePeriodRange('quarter', 0), /Unknown period/);
  });

  it('month offset=1 across year boundary (January → previous December)', () => {
    const now = new Date('2026-01-15T12:00:00+08:00');
    const { label } = computePeriodRange('month', 1, now);
    assert.equal(label, '2025-12-01 ~ 2025-12-31');
  });

  it('week across year boundary (first week of January, last week)', () => {
    // 2026-01-01 is a Thursday
    const now = new Date('2026-01-01T12:00:00+08:00');
    const { label } = computePeriodRange('week', 1, now);
    // Previous week is 2025-12-22 ~ 2025-12-28

    assert.equal(label, '2025-12-22 ~ 2025-12-28');
  });

  it('month offset=2 returns two months ago', () => {
    const now = new Date('2026-03-15T12:00:00+08:00');
    const { label } = computePeriodRange('month', 2, now);
    assert.equal(label, '2026-01-01 ~ 2026-01-31');
  });
});

describe('groupFrictions', () => {
  it('same leading 20 chars get grouped together, counts correct', () => {
    const frictions = [
      'SSH timeout connection refused on server',
      'SSH timeout connection refused again, retrying',
      'SSH timeout connection refused after fail2ban',
      'Docker cache not refreshed properly',
    ];
    const result = groupFrictions(frictions);
    // The first three entries share the leading 20 chars "ssh timeout connecti".
    assert.equal(result[0].count, 3);
    assert.ok(result[0].text.startsWith('SSH timeout'));
    assert.equal(result[1].count, 1);
  });

  it('case is treated as equal', () => {
    const frictions = ['SSH Timeout issue A1', 'ssh timeout issue A2'];
    const result = groupFrictions(frictions);
    // First 20 chars "ssh timeout issue a1" vs "ssh timeout issue a2" differ!
    // Swap to data whose leading 20 chars truly match.
    assert.equal(result.length, 2);
  });

  it('mixed case with identical leading 20 chars groups together', () => {
    const frictions = [
      'Docker Build Failed with error code 1',
      'docker build failed with error code 2',
    ];
    const result = groupFrictions(frictions);
    // "docker build failed " — leading 20 chars match exactly.
    assert.equal(result[0].count, 2);
  });

  it('empty array returns empty array', () => {
    assert.deepEqual(groupFrictions([]), []);
  });

  it('null/undefined entries are skipped', () => {
    const result = groupFrictions([null, undefined, '', 'valid friction text here']);
    assert.equal(result.length, 1);
    assert.equal(result[0].count, 1);
  });
});

describe('computeReportData', () => {
  it('returns the normal report structure', () => {
    const sessions = [
      { details: { friction_points: 'SSH timeout connection refused on server', suggestions: '加 retry' } },
      { details: { friction_points: 'SSH timeout connection refused again', suggestions: null } },
      { details: null },
    ];
    const result = computeReportData(sessions, 5, '2026-03-23 ~ 2026-03-29');
    assert.equal(result.period, '2026-03-23 ~ 2026-03-29');
    assert.equal(result.new_memories, 5);
    assert.equal(result.top_frictions[0].count, 2);
    assert.equal(result.top_suggestions[0].text, '加 retry');
    assert.ok(result.generated_at);
  });

  it('empty sessions return empty arrays', () => {
    const result = computeReportData([], 0, '2026-03-23 ~ 2026-03-29');
    assert.deepEqual(result.top_frictions, []);
    assert.deepEqual(result.top_suggestions, []);
    assert.equal(result.new_memories, 0);
  });

  // v1.26.59: an empty list used to mean four different things at once. The count of
  // rows the lists were computed from is what separates "we looked and there was
  // nothing" from "we had nothing to look at".
  it('reports how many session rows the lists were drawn from', () => {
    const sessions = [
      { details: { friction_points: 'a' } },
      { details: { suggestions: 'b' } },
      { details: {} },
    ];
    assert.equal(computeReportData(sessions, 0, 'x').sessions_analyzed, 3);
  });

  it('zero analysed sessions is distinguishable from analysed-and-found-nothing', () => {
    const none = computeReportData([], 0, 'x');
    const looked = computeReportData([{ details: { note: 'no friction field' } }], 0, 'x');
    assert.equal(none.sessions_analyzed, 0);
    assert.equal(looked.sessions_analyzed, 1);
    // Both lists are empty; only sessions_analyzed tells them apart.
    assert.deepEqual(none.top_frictions, looked.top_frictions);
  });

  // The route owns this count — it needs a database query the pure function cannot
  // run. Returning a hardcoded 0 here meant a caller that forgot to overwrite it
  // published a confident wrong number instead of an obviously missing one.
  it('does not invent the auto-created counts', () => {
    const result = computeReportData([], 0, 'x');
    assert.ok(!('friction_issues_created' in result));
    assert.ok(!('suggestion_actions_created' in result));
  });
});
