// v1.26.50 — broadcastRowVm() turns a broadcast_messages row + the current
// time into a per-row view-model. Pure function so the rendering rules
// (which the legacy card encoded inline in JSX) are executed by tests.
//
// The two rules that matter most:
//
//   1. `is_auto` rows are never revocable, matching the server guard at
//      src/routes/broadcast.js:165-169. A manual revoke would trigger the
//      nightly job to re-create the row on the next run.
//
//   2. "Active" means ends_at is null OR ends_at > now. A row past its
//      ends_at is styled at reduced opacity and shows no revoke button.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { broadcastRowVm, formatEffectiveRange } from '../client/src/pages/System/broadcast-row-vm.js';

const NOW = new Date('2026-08-01T12:00:00Z');

function row(overrides = {}) {
  return {
    id: 1, type: 'announcement', severity: 'info',
    title: 'Test broadcast', body: 'Hello',
    starts_at: '2026-08-01T00:00:00Z', ends_at: null,
    allow_snooze: false, snooze_hours: 24,
    cooldown_minutes: 1440,
    is_auto: false,
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

describe('broadcastRowVm — isActive / isRevocable', () => {
  it('active manual row is revocable', () => {
    const vm = broadcastRowVm(row(), NOW);
    assert.equal(vm.isActive, true);
    assert.equal(vm.isRevocable, true);
  });

  it('active is_auto row is NOT revocable', () => {
    // Server rejects manual revoke of is_auto rows; UI must not offer it.
    const vm = broadcastRowVm(row({ is_auto: true }), NOW);
    assert.equal(vm.isActive, true);
    assert.equal(vm.isRevocable, false);
  });

  it('row past ends_at is not active and not revocable', () => {
    const vm = broadcastRowVm(row({ ends_at: '2026-07-30T00:00:00Z' }), NOW);
    assert.equal(vm.isActive, false);
    assert.equal(vm.isRevocable, false);
  });

  it('row with ends_at in future is active', () => {
    const vm = broadcastRowVm(row({ ends_at: '2026-08-30T00:00:00Z' }), NOW);
    assert.equal(vm.isActive, true);
    assert.equal(vm.isRevocable, true);
  });

  it('row with ends_at null (permanent) is active', () => {
    const vm = broadcastRowVm(row({ ends_at: null }), NOW);
    assert.equal(vm.isActive, true);
  });
});

describe('broadcastRowVm — snooze label', () => {
  it('allow_snooze off → snoozeLabel empty', () => {
    const vm = broadcastRowVm(row({ allow_snooze: false, snooze_hours: 24 }), NOW);
    assert.equal(vm.snoozeLabel, '');
  });

  it('allow_snooze on → label is "{hours}h"', () => {
    const vm = broadcastRowVm(row({ allow_snooze: true, snooze_hours: 24 }), NOW);
    assert.equal(vm.snoozeLabel, '24h');
  });

  it('allow_snooze on with unusual hours', () => {
    const vm = broadcastRowVm(row({ allow_snooze: true, snooze_hours: 72 }), NOW);
    assert.equal(vm.snoozeLabel, '72h');
  });
});

describe('broadcastRowVm — effective range', () => {
  it('permanent (ends_at null) has endsAtLabel === null so the caller can inject the localized label', () => {
    // The pure function no longer carries user-facing text, so an admin in
    // Japanese does not read a Chinese "永久" label. The JSX layer decides.
    const vm = broadcastRowVm(row({ ends_at: null }), NOW);
    assert.equal(vm.endsAtLabel, null);
  });

  it('bounded range fills both endpoint labels', () => {
    const vm = broadcastRowVm(
      row({ starts_at: '2026-08-01T00:00:00Z', ends_at: '2026-08-30T00:00:00Z' }),
      NOW,
    );
    assert.ok(vm.startsAtLabel && vm.startsAtLabel !== '—');
    assert.ok(vm.endsAtLabel);
  });

  it('formatEffectiveRange injects the caller-supplied permanent label', () => {
    const permanent = broadcastRowVm(row({ ends_at: null }), NOW);
    assert.match(formatEffectiveRange(permanent, 'Forever'), / — Forever$/);
    assert.match(formatEffectiveRange(permanent, '永久'), / — 永久$/);

    const bounded = broadcastRowVm(
      row({ starts_at: '2026-08-01T00:00:00Z', ends_at: '2026-08-30T00:00:00Z' }),
      NOW,
    );
    assert.doesNotMatch(formatEffectiveRange(bounded, 'Forever'), /Forever/);
  });
});

describe('broadcastRowVm — auto badge', () => {
  it('is_auto row carries an auto-managed indicator string for the operator', () => {
    const vm = broadcastRowVm(row({ is_auto: true }), NOW);
    assert.equal(vm.isAuto, true);
  });

  it('manual row does not carry the auto flag', () => {
    const vm = broadcastRowVm(row({ is_auto: false }), NOW);
    assert.equal(vm.isAuto, false);
  });
});

describe('broadcastRowVm — type / severity classes', () => {
  // These are used to colour the badges; the test asserts the mapping so a
  // future edit that swaps colours around is caught.
  it('classifies known types', () => {
    assert.equal(broadcastRowVm(row({ type: 'announcement' }), NOW).typeColor, 'default');
    assert.equal(broadcastRowVm(row({ type: 'maintenance' }), NOW).typeColor, 'danger');
    assert.equal(broadcastRowVm(row({ type: 'rule_change' }), NOW).typeColor, 'purple');
    assert.equal(broadcastRowVm(row({ type: 'upgrade_reminder' }), NOW).typeColor, 'warning');
  });

  it('classifies severity', () => {
    assert.equal(broadcastRowVm(row({ severity: 'info' }), NOW).severityColor, 'success');
    assert.equal(broadcastRowVm(row({ severity: 'warning' }), NOW).severityColor, 'warning');
    assert.equal(broadcastRowVm(row({ severity: 'critical' }), NOW).severityColor, 'danger');
  });
});
