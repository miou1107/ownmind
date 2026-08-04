import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { teamUsageRowVm, sortTeamRows, coverageVm, dayBoundsIso, SORT_KEYS } =
  await import('../client/src/pages/Team/team-usage-vm.js');

/** A `users[]` entry of GET /api/usage/team-stats. */
function usageRow(id, totals = {}) {
  return {
    user: { id, name: `U${id}`, email: `${id}@x.com` },
    totals: {
      has_usage_data: true,
      input_tokens: '0', output_tokens: '0', reasoning_tokens: '0',
      cache_creation_tokens: '0', cache_read_tokens: '0',
      message_count: 0, active_seconds: 0, session_count: 0,
      ...totals,
    },
  };
}

/** A `members[]` entry of GET /api/usage/admin/team-overview. */
function overviewMember(id, extra = {}) {
  return {
    user_id: id,
    last_active_at: '2026-08-01T10:00:00.000Z',
    session_count: 4,
    top_project: 'OwnMind',
    rule_compliance: null,
    ...extra,
  };
}

describe('teamUsageRowVm', () => {
  it('a member with no usage data has absent totals, not zeros', () => {
    const r = teamUsageRowVm(usageRow(1, { has_usage_data: false }), null);
    assert.equal(r.measured, false);
    assert.equal(r.freshTokens, null, 'a token count we do not have is not 0');
    assert.equal(r.totalTokens, null);
    assert.equal(r.messageCount, null);
    assert.equal(r.activeSeconds, null);
    assert.equal(r.usageSessionCount, null);
  });

  it('a reported zero stays a zero', () => {
    const r = teamUsageRowVm(usageRow(1, { has_usage_data: true }), null);
    assert.equal(r.measured, true);
    assert.equal(r.freshTokens, 0);
    assert.equal(r.messageCount, 0);
  });

  // Cache is the same context read again. On the measured session it ran about
  // 250x the fresh figure, so folding it into one number would rank members by
  // how long their conversations were rather than by how much they asked for.
  it('separates new input plus output from the cache-inclusive total', () => {
    const r = teamUsageRowVm(usageRow(1, {
      input_tokens: '100', output_tokens: '50', reasoning_tokens: '7',
      cache_creation_tokens: '1000', cache_read_tokens: '25000',
    }), null);
    assert.equal(r.freshTokens, 157, 'input + output + reasoning');
    assert.equal(r.totalTokens, 26157, 'fresh + cache write + cache read');
  });

  it('a member absent from the overview has no session history, not a zero', () => {
    const r = teamUsageRowVm(usageRow(1), null);
    assert.equal(r.hasActivity, false);
    assert.equal(r.sessionCount, null);
    assert.equal(r.lastActiveIso, null);
    assert.equal(r.topProject, null);
    assert.equal(r.complianceRate, null);
  });

  it('carries the overview fields when the member does appear in it', () => {
    const r = teamUsageRowVm(usageRow(1), overviewMember(1));
    assert.equal(r.hasActivity, true);
    assert.equal(r.sessionCount, 4);
    assert.equal(r.topProject, 'OwnMind');
    assert.equal(r.lastActiveIso, '2026-08-01T10:00:00.000Z');
  });

  // team-overview returns a fraction; complianceBand thresholds are percent.
  // Handing 0.95 straight to the band would paint a 95% member solid red.
  it('converts the compliance fraction to a percentage before banding', () => {
    const r = teamUsageRowVm(usageRow(1), overviewMember(1, {
      rule_compliance: { complied: 19, triggered: 20, rate: 0.95 },
    }));
    assert.equal(r.complianceRate, 95);
    assert.equal(r.complianceBand, 'high');
  });

  it('no rule triggered in the period is unmeasured, not zero percent', () => {
    const r = teamUsageRowVm(usageRow(1), overviewMember(1, { rule_compliance: null }));
    assert.equal(r.complianceRate, null);
    assert.equal(r.complianceBand, 'unmeasured');
  });

  it('falls back to the email when a member has no name', () => {
    const row = usageRow(1);
    row.user.name = '';
    assert.equal(teamUsageRowVm(row, null).label, '1@x.com');
  });
});

describe('sortTeamRows', () => {
  const measured = (id, totals) => teamUsageRowVm(usageRow(id, totals), null);
  const unmeasured = (id) => teamUsageRowVm(usageRow(id, { has_usage_data: false }), null);

  it('orders by the chosen metric, descending', () => {
    const rows = sortTeamRows([
      measured(1, { input_tokens: '10' }),
      measured(2, { input_tokens: '90' }),
      measured(3, { input_tokens: '50' }),
    ], 'usage');
    assert.deepEqual(rows.map((r) => r.id), [2, 3, 1]);
  });

  // The whole point of marking them: a member we have no data for must not be
  // ranked above a member who genuinely did nothing, as though both were 0.
  //
  // The zero-valued measured member with the *higher* id is what gives this test
  // teeth. With rows that all have distinct non-zero metrics, the ordering comes
  // out the same whether or not the rule exists, so an earlier version of this
  // test stayed green when the rule was deleted.
  it('puts members with no data last whatever the metric', () => {
    for (const key of SORT_KEYS) {
      const rows = sortTeamRows([
        unmeasured(1),
        measured(2),
        unmeasured(3),
        measured(4, { input_tokens: '9', message_count: 9, active_seconds: 9 }),
      ], key);
      assert.deepEqual(rows.map((r) => r.id), [4, 2, 1, 3], `sorted by ${key}`);
    }
  });

  it('sorts by messages and by active time as well as by tokens', () => {
    const rows = [
      measured(1, { input_tokens: '99', message_count: 1, active_seconds: 5 }),
      measured(2, { input_tokens: '1', message_count: 99, active_seconds: 1 }),
    ];
    assert.deepEqual(sortTeamRows(rows, 'usage').map((r) => r.id), [1, 2]);
    assert.deepEqual(sortTeamRows(rows, 'messages').map((r) => r.id), [2, 1]);
    assert.deepEqual(sortTeamRows(rows, 'active').map((r) => r.id), [1, 2]);
  });

  it('breaks ties by id so the order does not shuffle between renders', () => {
    const rows = sortTeamRows([measured(3), measured(1), measured(2)], 'usage');
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
  });

  it('does not mutate the array it was given', () => {
    const input = [measured(1, { input_tokens: '1' }), measured(2, { input_tokens: '9' })];
    sortTeamRows(input, 'usage');
    assert.deepEqual(input.map((r) => r.id), [1, 2]);
  });
});

describe('dayBoundsIso', () => {
  // The legacy page sent the bare date. `new Date('2026-08-04')` is UTC midnight
  // by specification, which in Taipei is 08:00 that morning — so asking for a
  // window ending "today" silently dropped everything logged during the working
  // day, and 最近活動 could never show it.
  it('ends the window at the close of the Taipei day, not at 08:00', () => {
    const { toIso } = dayBoundsIso('2026-08-01', '2026-08-04');
    assert.equal(new Date(toIso).toISOString(), '2026-08-04T15:59:59.999Z');
    assert.ok(new Date(toIso) > new Date('2026-08-04'),
      'the bare-date parse is what cut the day short');
  });

  it('starts at the opening of the Taipei day', () => {
    const { fromIso } = dayBoundsIso('2026-08-01', '2026-08-04');
    assert.equal(new Date(fromIso).toISOString(), '2026-07-31T16:00:00.000Z');
  });
});

describe('coverageVm', () => {
  it('states the denominator the ranking covers', () => {
    const c = coverageVm({
      total_users: 9, measured: 6, unmeasured: 2, opted_out: 1,
      unmeasured_users: [{ id: 3, name: 'A' }, { id: 4, name: 'B' }], exempt_users: [],
    });
    assert.equal(c.measured, 6);
    assert.equal(c.totalUsers, 9);
    assert.equal(c.pct, 75, '6 of the 8 members we are trying to measure');
    assert.deepEqual(c.missingNames, ['A', 'B']);
  });

  it('flags an incomplete ranking below the four-fifths mark', () => {
    assert.equal(coverageVm({ total_users: 10, measured: 7 }).incomplete, true);
    assert.equal(coverageVm({ total_users: 10, measured: 8 }).incomplete, false);
  });

  // The exempt are excluded from the warning: they are missing on purpose, and
  // counting them as a gap would leave the banner permanently on.
  it('the exempt do not make coverage look broken', () => {
    const c = coverageVm({ total_users: 10, measured: 8, unmeasured: 0, opted_out: 2 });
    assert.equal(c.incomplete, false);
    assert.equal(c.pct, 100, '8 of the 8 members we are trying to measure');
  });

  it('an empty team is not a division by zero', () => {
    const c = coverageVm({ total_users: 0, measured: 0, unmeasured: 0, opted_out: 0 });
    assert.equal(c.pct, null);
    assert.equal(c.incomplete, false);
  });

  it('a missing payload reads as unknown, not as full coverage', () => {
    const c = coverageVm(null);
    assert.equal(c.known, false);
    assert.equal(c.pct, null);
  });

  it('names members by email when they have no name', () => {
    const c = coverageVm({
      total_users: 2, measured: 1, unmeasured: 1, opted_out: 0,
      unmeasured_users: [{ id: 5, name: null, email: 'x@y.com' }],
    });
    assert.deepEqual(c.missingNames, ['x@y.com']);
  });
});
