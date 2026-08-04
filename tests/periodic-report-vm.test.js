// v1.26.59 — 週報月報 (consolidation Stage 7).
//
// The legacy tab printed 本期無 friction 資料 for four different situations. These
// tests are mostly about keeping them four.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  PERIODS, OFFSETS, listStateVm, retentionVm, cardsVm, periodLabelOf,
} from '../client/src/pages/Portal/periodic-report-vm.js';

const DAY = 86400000;

/** A report the server would actually send, overridable per test. */
function report(over = {}) {
  return {
    period: '2026-07-27 ~ 2026-08-02',
    period_start: '2026-07-26T16:00:00.000Z',
    period_end: '2026-08-02T15:59:59.999Z',
    detail_retention_cutoff: '2026-05-06T00:00:00.000Z',
    new_memories: 5,
    friction_issues_created: 2,
    suggestion_actions_created: 1,
    sessions_total: 12,
    sessions_analyzed: 9,
    sessions_compressed: 0,
    top_frictions: [{ text: 'SSH timeout', count: 3 }],
    top_suggestions: [{ text: '加 retry', count: 4 }],
    generated_at: '2026-08-04T00:00:00.000Z',
    ...over,
  };
}

describe('periodic-report-vm — controls', () => {
  it('offers exactly the periods and offsets the legacy tab did', () => {
    assert.deepEqual(PERIODS, ['week', 'month']);
    assert.deepEqual(OFFSETS, [0, 1, 2, 3]);
  });

  it('falls back to a dash when the server sent no label', () => {
    assert.equal(periodLabelOf(report()), '2026-07-27 ~ 2026-08-02');
    assert.equal(periodLabelOf({}), null);
    assert.equal(periodLabelOf(null), null);
  });
});

describe('periodic-report-vm — the four emptinesses', () => {
  it('a populated list is just a populated list', () => {
    const vm = listStateVm(report(), 'top_frictions');
    assert.equal(vm.state, 'ok');
    assert.equal(vm.rows.length, 1);
    assert.equal(vm.sessionsAnalyzed, 9);
  });

  it('no session logged at all is not "no friction"', () => {
    const vm = listStateVm(
      report({ sessions_total: 0, sessions_analyzed: 0, top_frictions: [] }),
      'top_frictions',
    );
    assert.equal(vm.state, 'no_sessions');
    assert.deepEqual(vm.rows, []);
  });

  it('sessions logged but none carried the reflection fields', () => {
    const vm = listStateVm(
      report({ sessions_total: 12, sessions_analyzed: 0, top_suggestions: [] }),
      'top_suggestions',
    );
    assert.equal(vm.state, 'no_details');
    // The reader needs the denominator to see this is a reporting gap, not an
    // idle period.
    assert.equal(vm.sessionsTotal, 12);
  });

  it('analysed sessions that genuinely contained nothing is a real zero', () => {
    const vm = listStateVm(
      report({ sessions_total: 12, sessions_analyzed: 9, top_frictions: [] }),
      'top_frictions',
    );
    assert.equal(vm.state, 'measured_empty');
    assert.equal(vm.sessionsAnalyzed, 9);
  });

  it('a window whose only rows are compression summaries says so', () => {
    // Found in adversarial review. compressOldSessions replaces a month of sessions
    // with one summary row stamped at the 1st, carrying no details. Counting that row
    // as a session made the page say "12 records but nobody filled in the reflection
    // fields — that is a reporting gap", when the truth is the opposite: the notes
    // existed and retention deleted them.
    const vm = listStateVm(
      report({ sessions_total: 0, sessions_analyzed: 0, sessions_compressed: 1, top_frictions: [] }),
      'top_frictions',
    );
    assert.equal(vm.state, 'compressed_only');
    assert.equal(vm.sessionsCompressed, 1);
  });

  it('no rows at all is still no_sessions, not compressed', () => {
    const vm = listStateVm(
      report({ sessions_total: 0, sessions_analyzed: 0, sessions_compressed: 0, top_frictions: [] }),
      'top_frictions',
    );
    assert.equal(vm.state, 'no_sessions');
  });

  it('live rows alongside a compression summary read as the live rows', () => {
    // A window that straddles the cutoff has both. The live rows are what the lists
    // were actually drawn from, so they decide the sentence; the retention banner is
    // what tells the reader the window is partial.
    const vm = listStateVm(
      report({ sessions_total: 4, sessions_analyzed: 0, sessions_compressed: 1, top_suggestions: [] }),
      'top_suggestions',
    );
    assert.equal(vm.state, 'no_details');
    assert.equal(vm.sessionsTotal, 4);
  });

  it('a server that did not send the counts is unknown, not zero', () => {
    // Guessing here would resurrect exactly the bug this stage removes: one
    // sentence covering situations we cannot tell apart.
    const { sessions_total: _t, sessions_analyzed: _a, ...rest } = report({ top_frictions: [] });
    assert.equal(listStateVm(rest, 'top_frictions').state, 'unknown');
  });

  it('no report at all is unknown for both lists', () => {
    assert.equal(listStateVm(null, 'top_frictions').state, 'unknown');
    assert.equal(listStateVm(null, 'top_suggestions').state, 'unknown');
  });

  it('the two lists are read independently', () => {
    const vm = report({ top_frictions: [], top_suggestions: [{ text: 'x', count: 3 }] });
    assert.equal(listStateVm(vm, 'top_frictions').state, 'measured_empty');
    assert.equal(listStateVm(vm, 'top_suggestions').state, 'ok');
  });
});

describe('periodic-report-vm — retention', () => {
  it('a recent period is unaffected', () => {
    const vm = retentionVm(report());
    assert.equal(vm.known, true);
    assert.equal(vm.affected, false);
  });

  it('a window entirely older than the cutoff has lost its detail', () => {
    const vm = retentionVm(report({
      period_start: '2026-01-01T00:00:00.000Z',
      period_end: '2026-01-31T00:00:00.000Z',
      detail_retention_cutoff: '2026-05-06T00:00:00.000Z',
    }));
    assert.equal(vm.affected, true);
    assert.equal(vm.whole, true);
  });

  it('a window that straddles the cutoff is still flagged', () => {
    // The dangerous case: the surviving days return a partial list that looks
    // like a whole one, so silence here would be worse than in the whole case.
    const vm = retentionVm(report({
      period_start: '2026-05-01T00:00:00.000Z',
      period_end: '2026-05-31T00:00:00.000Z',
      detail_retention_cutoff: '2026-05-06T00:00:00.000Z',
    }));
    assert.equal(vm.affected, true);
    assert.equal(vm.whole, false);
  });

  it('the boundary itself is not flagged', () => {
    const at = '2026-05-06T00:00:00.000Z';
    const vm = retentionVm(report({ period_start: at, period_end: at, detail_retention_cutoff: at }));
    assert.equal(vm.affected, false);
  });

  it('a missing cutoff is unknown rather than assumed safe', () => {
    const { detail_retention_cutoff: _c, ...rest } = report();
    assert.equal(retentionVm(rest).known, false);
    assert.equal(retentionVm(null).known, false);
  });

  it('an unparseable date is unknown rather than NaN-compared', () => {
    // new Date('nonsense') > anything is false, which would silently read as
    // "not affected" — the fail-open direction.
    assert.equal(retentionVm(report({ detail_retention_cutoff: 'nonsense' })).known, false);
    assert.equal(retentionVm(report({ period_start: '' })).known, false);
  });

  it('the flag does not depend on the lists being empty', () => {
    const vm = retentionVm(report({
      period_start: '2026-01-01T00:00:00.000Z',
      period_end: '2026-01-31T00:00:00.000Z',
      top_frictions: [{ text: 'survived compression somehow', count: 9 }],
    }));
    assert.equal(vm.affected, true);
  });

  it('reads the cutoff from the server, not from a client clock', () => {
    // The client has no business knowing SESSION_RETENTION_DAYS, and a skewed
    // browser clock must not change what the page claims.
    const far = new Date(Date.now() + 400 * DAY).toISOString();
    assert.equal(retentionVm(report({ detail_retention_cutoff: far })).affected, true);
  });
});

describe('periodic-report-vm — cards', () => {
  it('renders the three legacy cards in order', () => {
    const cards = cardsVm(report());
    assert.deepEqual(cards.map((c) => c.key), [
      'new_memories', 'friction_issues_created', 'suggestion_actions_created',
    ]);
    assert.deepEqual(cards.map((c) => c.value), [5, 2, 1]);
  });

  it('a genuine zero renders as zero', () => {
    const cards = cardsVm(report({ suggestion_actions_created: 0 }));
    assert.equal(cards[2].value, 0);
    assert.equal(cards[2].absent, false);
  });

  it('a count the server did not send is absent, not zero', () => {
    // This is the defect being fixed: suggestion_actions_created was never emitted,
    // and `?? '—'` in the legacy console made every request look like a rendering
    // quirk rather than a missing measurement.
    const { suggestion_actions_created: _s, ...rest } = report();
    const cards = cardsVm(rest);
    assert.equal(cards[2].absent, true);
    assert.equal(cards[2].value, null);
  });

  it('no report yields three absent cards rather than three zeros', () => {
    const cards = cardsVm(null);
    assert.equal(cards.length, 3);
    assert.ok(cards.every((c) => c.absent === true && c.value === null));
  });

  it('a non-numeric count is absent rather than rendered raw', () => {
    const cards = cardsVm(report({ new_memories: 'lots' }));
    assert.equal(cards[0].absent, true);
  });
});
