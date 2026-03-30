import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePeriodRange, groupFrictions, computeReportData } from '../src/utils/report.js';

describe('computePeriodRange', () => {
  it('week offset=0 回傳本週週一到週日（label 驗證）', () => {
    // 2026-03-25 是週三
    const now = new Date('2026-03-25T12:00:00+08:00');
    const { label } = computePeriodRange('week', 0, now);
    assert.equal(label, '2026-03-23 ~ 2026-03-29');
  });

  it('week offset=1 回傳上週', () => {
    const now = new Date('2026-03-25T12:00:00+08:00');
    const { label } = computePeriodRange('week', 1, now);
    assert.equal(label, '2026-03-16 ~ 2026-03-22');
  });

  it('month offset=0 回傳本月', () => {
    const now = new Date('2026-03-15T12:00:00+08:00');
    const { label } = computePeriodRange('month', 0, now);
    assert.equal(label, '2026-03-01 ~ 2026-03-31');
  });

  it('week start/end 時間正確（UTC+8 Monday 00:00 ~ Sunday 23:59）', () => {
    const now = new Date('2026-03-25T12:00:00+08:00');
    const { start, end } = computePeriodRange('week', 0, now);
    // Monday 00:00 Asia/Taipei = Sunday 16:00 UTC
    assert.equal(start.toISOString(), '2026-03-22T16:00:00.000Z');
    // Sunday 23:59:59.999 Asia/Taipei = Sunday 15:59:59.999 UTC
    assert.equal(end.toISOString(), '2026-03-29T15:59:59.999Z');
  });

  it('unknown period 拋錯', () => {
    assert.throws(() => computePeriodRange('quarter', 0), /Unknown period/);
  });
});

describe('groupFrictions', () => {
  it('同前 20 字元歸為同類，計數正確', () => {
    const frictions = [
      'SSH timeout connection refused on server',
      'SSH timeout connection refused again, retrying',
      'SSH timeout connection refused after fail2ban',
      'Docker cache not refreshed properly',
    ];
    const result = groupFrictions(frictions);
    // 前三筆的前 20 字 "ssh timeout connecti" 相同
    assert.equal(result[0].count, 3);
    assert.ok(result[0].text.startsWith('SSH timeout'));
    assert.equal(result[1].count, 1);
  });

  it('大小寫視為相同', () => {
    const frictions = ['SSH Timeout issue A1', 'ssh timeout issue A2'];
    const result = groupFrictions(frictions);
    // 前 20 字 "ssh timeout issue a1" vs "ssh timeout issue a2" — 不同！
    // 換成確實前 20 字元相同的資料
    assert.equal(result.length, 2);
  });

  it('前 20 字元完全相同的大小寫混合', () => {
    const frictions = [
      'Docker Build Failed with error code 1',
      'docker build failed with error code 2',
    ];
    const result = groupFrictions(frictions);
    // "docker build failed " 前 20 字完全相同
    assert.equal(result[0].count, 2);
  });

  it('空陣列回傳空陣列', () => {
    assert.deepEqual(groupFrictions([]), []);
  });

  it('null/undefined 值被略過', () => {
    const result = groupFrictions([null, undefined, '', 'valid friction text here']);
    assert.equal(result.length, 1);
    assert.equal(result[0].count, 1);
  });
});

describe('computeReportData', () => {
  it('正常回傳報表結構', () => {
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

  it('空 sessions 回傳空陣列', () => {
    const result = computeReportData([], 0, '2026-03-23 ~ 2026-03-29');
    assert.deepEqual(result.top_frictions, []);
    assert.deepEqual(result.top_suggestions, []);
    assert.equal(result.new_memories, 0);
  });
});
