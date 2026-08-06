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
