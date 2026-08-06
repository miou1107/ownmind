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

/**
 * The transform every delivery path applies to a broadcast body before the
 * reader sees it. Copied verbatim from hooks/lib/render-session-context.js and
 * mcp/index.js — if this line ever stops matching those two, these tests are
 * measuring something the reader never sees.
 */
const deliver = (body) => String(body || '').split('\n').slice(0, 5).join(' ').slice(0, 400);

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
    // Two entries now share the delivery window: the oversized one is shortened
    // rather than pushing the other one out, so nothing is omitted.
    const huge = failure({ detail: 'x'.repeat(5000) });
    const out = renderAlertMessage([huge, failure({ machine: 'TANK' })]);
    assert.ok(out.body.length <= BROADCAST_BODY_LIMIT);
    assert.ok(out.body.length > 0);
    assert.match(out.body, /…/, 'the cut must be visible');
    assert.equal(out.omitted, 0);
    assert.ok(deliver(out.body).includes('TANK'), 'the second entry must still be delivered');
  });
});

describe('renderAlertMessage — what the reader actually receives', () => {
  // The body is stored whole, but hooks/lib/render-session-context.js and
  // mcp/index.js only ever show the first 5 lines and the first 400 characters
  // of them joined. Everything below asserts on the delivered text, not the
  // stored text, because the stored text is not what anyone reads.

  it('the second entry survives delivery', () => {
    const { body } = renderAlertMessage([
      failure(),
      failure({
        check_name: 'scheduler',
        machine: 'TANK',
        user_name: 'Bob',
        user_id: 4,
        detail: 'launchd job is not registered',
      }),
    ]);
    const delivered = deliver(body);

    assert.ok(delivered.includes('memory_load'), 'first check name missing');
    assert.ok(delivered.includes('LAPTOP-MBGGLV2J'), 'first machine missing');
    assert.ok(delivered.includes('scheduler'), 'second check name missing');
    assert.ok(delivered.includes('TANK'), 'second machine missing');
  });

  it('every delivered entry still names its client version', () => {
    const { body } = renderAlertMessage([
      failure({ client_version: '1.26.84' }),
      failure({
        check_name: 'scheduler',
        machine: 'TANK',
        user_name: 'Bob',
        user_id: 4,
        detail: 'launchd job is not registered',
        client_version: '1.26.85',
      }),
    ]);
    const delivered = deliver(body);

    assert.ok(delivered.includes('1.26.84'), "the first entry's version missing");
    assert.ok(delivered.includes('1.26.85'), "the second entry's version missing");
  });

  it('the omitted-count footer survives delivery, with the right count', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      failure({ machine: `M${i}`, user_id: 200 + i, detail: `${WSL_DETAIL} #${i}` }));
    const { body, omitted } = renderAlertMessage(many);
    const delivered = deliver(body);

    assert.ok(omitted > 0, 'this fixture is meant to overflow');
    assert.ok(delivered.includes(`另有 ${omitted} 項未列出`),
      `the footer was cut off; delivered text was: ${delivered}`);
    assert.ok(delivered.includes('總共 60 項'), 'the total was cut off');

    const shown = many.reduce((n, f) => n + (delivered.includes(`（${f.machine}）`) ? 1 : 0), 0);
    assert.equal(shown + omitted, 60, 'shown + omitted must equal the total');
  });

  it('a body with several entries stays inside the delivery envelope', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      failure({ machine: `M${i}`, user_id: 300 + i, detail: `${WSL_DETAIL} #${i}` }));
    const { body } = renderAlertMessage(many);

    assert.ok(body.split('\n').length <= 5, `body used ${body.split('\n').length} lines`);
    assert.ok(deliver(body).length <= 400, 'delivered text overflowed 400 characters');
    // Nothing was thrown away by the transform: what is stored is what is shown.
    assert.equal(deliver(body), body.split('\n').join(' '));
  });

  it('a multi-line detail cannot spend another entry\'s line', () => {
    const { body } = renderAlertMessage([
      failure({ detail: 'line one\nline two\nline three\nline four\nline five' }),
      failure({ check_name: 'scheduler', machine: 'TANK', detail: 'short' }),
    ]);

    assert.equal(body.split('\n').length, 2, 'each entry must occupy exactly one line');
    assert.ok(deliver(body).includes('TANK'));
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
    assert.ok(!body.includes('未列出'),
      'a footer that announces zero omissions is worse than no footer');
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
