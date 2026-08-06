// tests/install-check-alert-message.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderAlertMessage, BROADCAST_BODY_LIMIT } from '../src/lib/install-check-alert-message.js';

const WSL_DETAIL = 'memories have never loaded automatically on this account (`bash` on this machine is the WSL launcher, whose home directory is not this one)';
const WSL_FIX = 'Re-run the installer, then fully restart your AI tool and open a new conversation';

function failure(overrides = {}) {
  return {
    user_id: 3,
    user_name: 'Adam',
    machine: 'LAPTOP-MBGGLV2J',
    check_name: 'memory_load',
    detail: WSL_DETAIL,
    fix: WSL_FIX,
    client_version: '1.26.84',
    ...overrides,
  };
}

describe('renderAlertMessage — one entry carries everything needed to act', () => {
  const { title, body, omitted } = renderAlertMessage([failure()]);

  it('names the check, the person and the machine', () => {
    assert.match(body, /memory_load/);
    assert.match(body, /Adam/);
    assert.match(body, /LAPTOP-MBGGLV2J/);
  });

  it('carries the reason and the fix verbatim', () => {
    assert.ok(body.includes(WSL_DETAIL));
    assert.ok(body.includes(WSL_FIX));
  });

  it('carries the client version', () => {
    assert.match(body, /1\.26\.84/);
  });

  it('counts the problem in the title', () => {
    assert.match(title, /1/);
    assert.ok(title.length <= 200);
  });

  it('omits nothing', () => {
    assert.equal(omitted, 0);
  });
});

describe('renderAlertMessage — rollup', () => {
  it('six machines with one cause read as one entry', () => {
    const machines = ['LAPTOP-MBGGLV2J', 'TANK', 'after', 'LAPTOP-G95HIQ3V', 'LAPTOP-RGE2HCSQ', 'Fontrip-Joanna'];
    const failures = machines.map((m, i) => failure({ machine: m, user_name: `U${i}`, user_id: 100 + i }));
    const { body } = renderAlertMessage(failures);

    assert.equal(body.split('memory_load').length - 1, 1, 'the check name should appear once');
    for (const m of machines) assert.ok(body.includes(m), `${m} missing`);
  });

  it('the same check with different causes stays two entries', () => {
    const { body } = renderAlertMessage([
      failure({ check_name: 'scheduler', detail: 'launchd not registered' }),
      failure({ check_name: 'scheduler', detail: 'Task Scheduler state=Disabled', machine: 'TANK' }),
    ]);
    assert.equal(body.split('scheduler').length - 1, 2);
  });
});

describe('renderAlertMessage — truncation says so', () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    failure({ machine: `M${i}`, user_id: 200 + i, detail: `${WSL_DETAIL} #${i}` }));
  const { body, omitted } = renderAlertMessage(many);

  it('respects the broadcast body limit', () => {
    assert.ok(body.length <= BROADCAST_BODY_LIMIT, `body was ${body.length}`);
  });

  it('reports how many entries were left out', () => {
    assert.ok(omitted > 0, 'this fixture is meant to overflow');
    assert.match(body, new RegExp(String(omitted)));
  });

  it('the stated count plus the shown count equals the total', () => {
    const shown = body.split('memory_load').length - 1;
    assert.equal(shown + omitted, 60);
  });

  it('a single oversized entry is still delivered, marked as cut', () => {
    const huge = failure({ detail: 'x'.repeat(5000) });
    const out = renderAlertMessage([huge, failure({ machine: 'TANK' })]);
    assert.ok(out.body.length <= BROADCAST_BODY_LIMIT);
    assert.ok(out.body.length > 0);
    assert.equal(out.omitted, 1);
  });
});

describe('renderAlertMessage — nothing to say', () => {
  it('returns an empty body for an empty list', () => {
    const { body, omitted } = renderAlertMessage([]);
    assert.equal(body, '');
    assert.equal(omitted, 0);
  });
});

describe('renderAlertMessage — truncation algorithm correctness', () => {
  it('does not spuriously truncate when all entries fit', () => {
    // Bug: old algorithm pessimistically reserved footer space for remaining entries.
    // Even when all entries fit, it would reject entry[0] if entry[0] + footer > limit,
    // causing spurious truncation of content that would have fit whole.
    //
    // This test uses minimal names (short check_name, machine, user_name, fix) to construct:
    // - entry[0] rendered to ~1981 chars (large detail, minimal overhead)
    // - entry[1] rendered to ~13 chars (empty detail, empty fix/version)
    // - entry[0] + footer(1,2) = 1981 + 20 = 2001 > 2000 (old algo rejects)
    // - entry[0] + sep + entry[1] = 1981 + 2 + 13 = 1996 < 2000 (would fit)

    const failures = [
      failure({
        detail: 'x'.repeat(1953),
        check_name: 'c',
        machine: 'M1',
        user_name: 'A',
        user_id: 1,
        fix: ''  // Empty fix to reduce entry size
      }),
      failure({
        detail: '',  // Empty detail to keep entry minimal
        check_name: 'c',
        machine: 'M2',
        user_name: 'B',
        user_id: 2,
        fix: '',  // Empty fix
        client_version: ''  // Empty version
      })
    ];

    const { body, omitted } = renderAlertMessage(failures);

    // Both entries should fit and appear whole (no spurious truncation)
    assert.equal(omitted, 0, 'entries should not be omitted when they fit');
    assert.ok(body.includes('M1'), 'first machine missing');
    assert.ok(body.includes('M2'), 'second machine missing');
    assert.ok(body.length <= BROADCAST_BODY_LIMIT, `body was ${body.length}`);
  });

  it('cuts single oversized entry with visible marker', () => {
    const huge = failure({ detail: 'x'.repeat(5000) });
    const { body, omitted } = renderAlertMessage([huge]);

    assert.ok(body.length <= BROADCAST_BODY_LIMIT, `body was ${body.length}`);
    assert.ok(body.length > 0, 'body must not be empty');
    assert.match(body, /…/, 'cut marker should be present');
    assert.equal(omitted, 0, 'no entries omitted when only one entry');
  });

  it('reports omitted count equal to entries left out of body', () => {
    // Create enough entries to force truncation and verify omitted count
    // matches the number of entries actually not shown in the body.
    const many = Array.from({ length: 50 }, (_, i) =>
      failure({ machine: `Machine${i}`, user_id: 400 + i, detail: `reason_${i}` })
    );
    const { body, omitted } = renderAlertMessage(many);

    // Count how many distinct machine names appear in the body.
    const shown = many.reduce((sum, m) => {
      return sum + (body.includes(m.machine) ? 1 : 0);
    }, 0);

    assert.equal(shown + omitted, many.length, 'shown + omitted must equal total');
    assert.ok(omitted > 0, 'this fixture should overflow');
  });

  it('handles client_version empty string gracefully', () => {
    const { body, omitted } = renderAlertMessage([failure({ client_version: '' })]);

    assert.equal(omitted, 0);
    // Empty version string should not appear in body (not added to Set)
    assert.ok(!body.includes('版本 '));
  });
});
