import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { detailTotalsVm, usageBarRows, sessionRowVm, osDisplayName } =
  await import('../client/src/pages/Team/member-detail-vm.js');

describe('detailTotalsVm', () => {
  const totals = {
    input_tokens: '100', output_tokens: '40', reasoning_tokens: '10',
    cache_creation_tokens: '500', cache_read_tokens: '9000',
    message_count: 12, wall_seconds: 7200, active_seconds: 3600, session_count: 5,
  };

  it('reports fresh and cached tokens as two figures, never one', () => {
    const cards = detailTotalsVm(totals, true);
    const by = Object.fromEntries(cards.map((c) => [c.key, c.value]));
    assert.equal(by.fresh_tokens, 150, 'input + output + reasoning');
    assert.equal(by.cache_tokens, 9500, 'cache write + cache read');
  });

  // Requirement 8: the cost calculation is removed, not fixed. The endpoint
  // still returns cost_usd; nothing on this page may render it.
  it('never surfaces a cost, whatever the endpoint sends', () => {
    const cards = detailTotalsVm({ ...totals, cost_usd: 12.5 }, true);
    assert.equal(cards.some((c) => /cost/i.test(c.key)), false);
    assert.equal(cards.some((c) => c.value === 12.5), false);
  });

  it('marks every figure absent when the member reported nothing', () => {
    const cards = detailTotalsVm({
      input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
      cache_creation_tokens: 0, cache_read_tokens: 0,
      message_count: 0, wall_seconds: 0, active_seconds: 0, session_count: 0,
    }, false);
    assert.equal(cards.every((c) => c.value === null), true);
  });

  it('a reported zero is still shown as zero', () => {
    const cards = detailTotalsVm({ message_count: 0 }, true);
    const messages = cards.find((c) => c.key === 'messages');
    assert.equal(messages.value, 0);
  });
});

describe('usageBarRows', () => {
  it('scales each bar against the busiest key', () => {
    const { rows } = usageBarRows([
      { key: '2026-08-01', input_tokens: '50', output_tokens: '50' },
      { key: '2026-08-02', input_tokens: '25', output_tokens: '25' },
    ]);
    assert.deepEqual(rows.map((r) => r.pct), [100, 50]);
    assert.deepEqual(rows.map((r) => r.tokens), [100, 50]);
  });

  it('keeps the order the server chose', () => {
    const { rows } = usageBarRows([
      { key: 'b', input_tokens: '1' }, { key: 'a', input_tokens: '9' },
    ]);
    assert.deepEqual(rows.map((r) => r.key), ['b', 'a']);
  });

  // Cursor and Antigravity report session counts and no tokens at all. A bar
  // chart of tokens over their series is legitimately empty, and the page has
  // to say why instead of drawing nothing.
  it('reports when a series carries sessions but no tokens', () => {
    const r = usageBarRows([{ key: 'cursor', input_tokens: 0, session_count: 12 }]);
    assert.equal(r.anyTokens, false);
    assert.equal(r.rows.length, 1);
  });

  it('an empty series is empty, not a zero-height chart', () => {
    const r = usageBarRows([]);
    assert.deepEqual(r.rows, []);
    assert.equal(r.anyTokens, false);
  });

  it('survives a null series', () => {
    assert.deepEqual(usageBarRows(null).rows, []);
  });
});

describe('sessionRowVm', () => {
  const session = {
    id: 7,
    created_at: '2026-08-01T10:00:00.000Z',
    tool: 'claude-code', model: 'opus', machine: 'vin-mac',
    machine_meta: { os: 'darwin', scanner_version: '1.26.57' },
    project: 'OwnMind', duration_turns: 42,
    rule_compliance: { complied: 9, triggered: 10, rate: 0.9 },
    summary: 'short summary',
  };

  it('spells out the platform code the collector sends', () => {
    assert.equal(osDisplayName('darwin'), 'macOS');
    assert.equal(osDisplayName('win32'), 'Windows');
    assert.equal(osDisplayName('linux'), 'Linux');
    assert.equal(osDisplayName('freebsd'), 'freebsd', 'an unmapped code passes through');
    assert.equal(osDisplayName(null), '');
  });

  it('builds the machine sub-label from os and scanner version', () => {
    assert.equal(sessionRowVm(session).machineMeta, 'macOS · 1.26.57');
  });

  it('omits the sub-label rather than printing a lone separator', () => {
    const r = sessionRowVm({ ...session, machine_meta: { os: 'darwin', scanner_version: null } });
    assert.equal(r.machineMeta, 'macOS');
    assert.equal(sessionRowVm({ ...session, machine_meta: null }).machineMeta, null);
  });

  it('converts the compliance fraction to a percentage and bands it', () => {
    const r = sessionRowVm(session);
    assert.equal(r.complianceRate, 90);
    assert.equal(r.complianceBand, 'high');
  });

  it('a session that triggered no rule is unmeasured, not zero percent', () => {
    const r = sessionRowVm({ ...session, rule_compliance: null });
    assert.equal(r.complianceRate, null);
    assert.equal(r.complianceBand, 'unmeasured');
  });

  it('truncates a long summary but keeps the full text for the tooltip', () => {
    const long = 'x'.repeat(200);
    const r = sessionRowVm({ ...session, summary: long });
    assert.equal(r.summary.length, 61, '60 characters plus the ellipsis');
    assert.equal(r.summaryFull, long);
    assert.equal(r.truncated, true);
  });

  it('leaves a short summary alone', () => {
    const r = sessionRowVm(session);
    assert.equal(r.summary, 'short summary');
    assert.equal(r.truncated, false);
  });

  it('keeps unreported fields null so the page can name the gap', () => {
    const r = sessionRowVm({ id: 1, created_at: null, summary: null });
    assert.equal(r.tool, null);
    assert.equal(r.model, null);
    assert.equal(r.project, null);
    assert.equal(r.turns, null);
    assert.equal(r.summary, '');
  });
});
