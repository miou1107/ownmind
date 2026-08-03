// v1.26.51 — validateBugStatusUpdate() mirrors the server-side guard at
// src/routes/bug-reports.js:536-557. Client-side validation prevents an
// invalid PATCH from hitting the network; the server enforces the same set
// for defence in depth.
//
// Two of the rules interact:
//   - status = 'wontfix' requires status_reason (else 400 server-side)
//   - status_reason = 'wontfix_other' requires status_reason_note (else 400)
//
// A rebuild that fails to enforce either would let the modal fire a request
// the server immediately rejects, so the user sees a bare error string
// instead of an actionable inline hint.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBugStatusUpdate } from '../client/src/pages/Admin/bug-status-update-validate.js';

describe('validateBugStatusUpdate — status enum', () => {
  it('accepts every documented status', () => {
    for (const s of ['new', 'triaged', 'in_progress', 'fixed']) {
      const r = validateBugStatusUpdate({ status: s });
      assert.equal(r.ok, true, `expected ${s} to validate ok`);
    }
  });

  it('rejects unknown status', () => {
    const r = validateBugStatusUpdate({ status: 'wat' });
    assert.equal(r.ok, false);
    assert.equal(r.errorKey, 'status');
  });

  it('rejects missing status', () => {
    const r = validateBugStatusUpdate({});
    assert.equal(r.ok, false);
    assert.equal(r.errorKey, 'status');
  });
});

describe('validateBugStatusUpdate — wontfix branch', () => {
  it('wontfix without status_reason is refused', () => {
    const r = validateBugStatusUpdate({ status: 'wontfix' });
    assert.equal(r.ok, false);
    assert.equal(r.errorKey, 'status_reason_required');
  });

  it('wontfix with a valid status_reason passes', () => {
    const r = validateBugStatusUpdate({
      status: 'wontfix',
      status_reason: 'by_design',
    });
    assert.equal(r.ok, true);
  });

  it('wontfix with an unknown status_reason is refused', () => {
    const r = validateBugStatusUpdate({
      status: 'wontfix',
      status_reason: 'not_a_thing',
    });
    assert.equal(r.ok, false);
    assert.equal(r.errorKey, 'status_reason_enum');
  });

  it('every documented status_reason passes when status is wontfix', () => {
    for (const reason of ['by_design', 'duplicate', 'low_priority', 'cannot_reproduce']) {
      const r = validateBugStatusUpdate({ status: 'wontfix', status_reason: reason });
      assert.equal(r.ok, true, `expected ${reason} to validate ok`);
    }
  });
});

describe('validateBugStatusUpdate — wontfix_other branch', () => {
  it('wontfix_other without a note is refused', () => {
    const r = validateBugStatusUpdate({
      status: 'wontfix',
      status_reason: 'wontfix_other',
    });
    assert.equal(r.ok, false);
    assert.equal(r.errorKey, 'status_reason_note_required');
  });

  it('wontfix_other with an empty-string note is refused', () => {
    const r = validateBugStatusUpdate({
      status: 'wontfix',
      status_reason: 'wontfix_other',
      status_reason_note: '   ',
    });
    assert.equal(r.ok, false);
    assert.equal(r.errorKey, 'status_reason_note_required');
  });

  it('wontfix_other with a substantive note passes', () => {
    const r = validateBugStatusUpdate({
      status: 'wontfix',
      status_reason: 'wontfix_other',
      status_reason_note: 'blocked by upstream',
    });
    assert.equal(r.ok, true);
  });
});

describe('validateBugStatusUpdate — non-wontfix ignores reason', () => {
  it('status_reason on non-wontfix is dropped, not an error', () => {
    // Server-side: setting status = 'fixed' with a status_reason still valid
    // enum passes the constraint; the reason column just isn't used until
    // status = 'wontfix'. Mirror that: don't refuse harmless data.
    const r = validateBugStatusUpdate({
      status: 'fixed',
      status_reason: 'by_design',
    });
    assert.equal(r.ok, true);
  });
});
