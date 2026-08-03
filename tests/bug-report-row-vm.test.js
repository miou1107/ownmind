// v1.26.51 — bugReportRowVm() turns a bug_reports row + a user-lookup map into
// the values the row template needs. Pure function so the branch rules the
// legacy card encoded inline in JSX are executed by tests.
//
// The three things the pure function must get right:
//
//   1. severityColor / statusColor map to fixed CSS classes. A future edit
//      swapping colours around should turn the suite red.
//   2. user_name resolution falls through to `user#{id}` when the id is not
//      in the fetched user list. Matches legacy behaviour.
//   3. Timestamp slicing matches the legacy `slice(0, 16).replace('T', ' ')`
//      shape — a minute-precision display, not seconds.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bugReportRowVm } from '../client/src/pages/Admin/bug-report-row-vm.js';

function row(overrides = {}) {
  return {
    id: 42,
    user_id: 7,
    title: 'Sample report',
    severity: 'medium',
    component: 'auth',
    status: 'new',
    status_reason: null,
    bug_fingerprint: 'clt_user_reported_other',
    created_at: '2026-07-15T04:30:22.000Z',
    resolved_at: null,
    ...overrides,
  };
}

const USER_MAP = {
  7: 'Alice',
  8: 'Bob',
};

describe('bugReportRowVm — severity colouring', () => {
  it('maps every known severity to its badge class', () => {
    assert.equal(bugReportRowVm(row({ severity: 'low' }), USER_MAP).severityColor, 'low');
    assert.equal(bugReportRowVm(row({ severity: 'medium' }), USER_MAP).severityColor, 'medium');
    assert.equal(bugReportRowVm(row({ severity: 'high' }), USER_MAP).severityColor, 'high');
    assert.equal(bugReportRowVm(row({ severity: 'critical' }), USER_MAP).severityColor, 'critical');
  });

  it('missing severity defaults to medium', () => {
    assert.equal(bugReportRowVm(row({ severity: null }), USER_MAP).severityColor, 'medium');
  });
});

describe('bugReportRowVm — status colouring', () => {
  it('maps every known status to its badge class', () => {
    for (const s of ['new', 'triaged', 'in_progress', 'fixed', 'wontfix']) {
      assert.equal(bugReportRowVm(row({ status: s }), USER_MAP).statusColor, s);
    }
  });

  it('carries the raw status label for the caller', () => {
    assert.equal(bugReportRowVm(row({ status: 'triaged' }), USER_MAP).statusLabel, 'triaged');
  });
});

describe('bugReportRowVm — user resolution', () => {
  it('resolves user_id via the map', () => {
    assert.equal(bugReportRowVm(row({ user_id: 7 }), USER_MAP).userLabel, 'Alice');
  });

  it('falls through to user#{id} when the user is not in the map', () => {
    // Legacy behaviour: some reports belong to users who were later deleted
    // from the users table; the id must still be readable.
    assert.equal(bugReportRowVm(row({ user_id: 999 }), USER_MAP).userLabel, 'user#999');
  });

  it('handles an empty user map without throwing', () => {
    assert.equal(bugReportRowVm(row({ user_id: 7 }), {}).userLabel, 'user#7');
  });
});

describe('bugReportRowVm — timestamp', () => {
  it('slices the ISO string to minute precision, replacing T with space', () => {
    // 2026-07-15T04:30:22.000Z → 2026-07-15 04:30
    // Legacy renders the string as-is; not localised. Preserve that.
    assert.equal(
      bugReportRowVm(row({ created_at: '2026-07-15T04:30:22.000Z' }), USER_MAP).createdAtLabel,
      '2026-07-15 04:30',
    );
  });

  it('empty created_at renders empty (no crash)', () => {
    assert.equal(
      bugReportRowVm(row({ created_at: null }), USER_MAP).createdAtLabel,
      '',
    );
  });
});

describe('bugReportRowVm — passthroughs', () => {
  it('carries id, title, component through unchanged', () => {
    const vm = bugReportRowVm(
      row({ id: 42, title: 'Something broke', component: 'billing' }),
      USER_MAP,
    );
    assert.equal(vm.id, 42);
    assert.equal(vm.title, 'Something broke');
    assert.equal(vm.componentLabel, 'billing');
  });

  it('empty component renders — (not empty string) so the cell reads right', () => {
    // Legacy: `${esc(r.component || '-')}`. Preserved but em-dash is easier
    // to see in Chinese rows than a plain hyphen.
    assert.equal(bugReportRowVm(row({ component: null }), USER_MAP).componentLabel, '—');
    assert.equal(bugReportRowVm(row({ component: '' }), USER_MAP).componentLabel, '—');
  });
});
