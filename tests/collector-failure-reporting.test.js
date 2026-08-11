// v1.26.142 — a collector that fails has to say so off the machine.
//
// The account this was written for holds a `claude-code` heartbeat updated every two hours
// and no `codex` row at all, on a machine whose owner works in Codex all day. `runScan`
// sends a heartbeat on every outcome it reaches — nothing installed, nothing new, could not
// read — so an absent row cannot be produced by an adapter that returned. The only way to
// end a run with no row is to throw, hang, or never be run.
//
// All three used to end with a line in `~/.ownmind/logs/scanner.log`: correct, complete,
// and on the one computer nobody is reading. From the server the tool simply was not there,
// which is indistinguishable from a member who has never installed it — and that is the
// reading it got for six weeks.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { reportCollectorState, redactHome } = await import('../shared/scanners/base.js');
const {
  ADAPTER_ERROR, ADAPTER_TIMEOUT, SKIPPED_BY_CONFIG, isReason, isCollectorFailure
} = await import('../shared/scanners/reasons.js');
const { buildSelfCheckReport } = await import('../shared/scanners/selfcheck.js');
const { withAdapterDeadline, ADAPTER_DEADLINE_MS } =
  await import('../hooks/ownmind-usage-scanner.js');
const { createEventsRouter } = await import('../src/routes/usage/events.js');

describe('the three collector-failure codes', () => {
  it('are recognised at the server boundary', () => {
    for (const r of [ADAPTER_ERROR, ADAPTER_TIMEOUT, SKIPPED_BY_CONFIG]) {
      assert.equal(isReason(r), true, `${r} must survive the boundary check`);
      assert.ok(r.length <= 32, `${r} must fit the column`);
    }
  });

  it('separate "the collector broke" from "the collector was not run"', () => {
    // Only the first two carry a message worth storing. A tool skipped by configuration
    // did not fail — it was told not to run — and writing an audit row for it would make
    // a deliberate setting look like an incident every two hours.
    assert.equal(isCollectorFailure(ADAPTER_ERROR), true);
    assert.equal(isCollectorFailure(ADAPTER_TIMEOUT), true);
    assert.equal(isCollectorFailure(SKIPPED_BY_CONFIG), false);
    assert.equal(isCollectorFailure('no_new_activity'), false);
    assert.equal(isCollectorFailure(null), false);
  });
});

describe('reportCollectorState', () => {
  function capture(response = { ok: true, json: async () => ({}) }) {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      if (typeof response === 'function') return response();
      return response;
    };
    return { calls, fetchFn };
  }

  it('sends a heartbeat-only payload carrying the reason and the message', async () => {
    const { calls, fetchFn } = capture();
    const sent = await reportCollectorState(
      { apiUrl: 'https://example.test/', apiKey: 'k', fetchFn },
      {
        tool: 'codex', reason: ADAPTER_ERROR, scannerVersion: '1.26.142',
        machine: 'LAPTOP-1', error: 'ENOENT: no such file'
      }
    );
    assert.equal(sent, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.test/api/usage/events');
    assert.deepEqual(calls[0].body.events, []);
    assert.deepEqual(calls[0].body.heartbeat, {
      tool: 'codex', reason: ADAPTER_ERROR, scanner_version: '1.26.142',
      machine: 'LAPTOP-1', error: 'ENOENT: no such file'
    });
  });

  it('omits the error key entirely when there is no message', async () => {
    // An empty string survives JSON.stringify where undefined does not, and the server
    // would store the absence of a message as a message.
    const { calls, fetchFn } = capture();
    await reportCollectorState(
      { apiUrl: 'https://example.test', apiKey: 'k', fetchFn },
      { tool: 'codex', reason: SKIPPED_BY_CONFIG, scannerVersion: '1.26.142', machine: 'M' }
    );
    assert.equal('error' in calls[0].body.heartbeat, false);
  });

  it('returns false and does not throw when the report itself fails', async () => {
    // This runs inside the scanner's failure handler. A diagnostic that can end the run
    // is worse than the defect it reports.
    const warned = [];
    const sent = await reportCollectorState(
      {
        apiUrl: 'https://example.test', apiKey: 'k',
        fetchFn: async () => { throw new Error('offline'); },
        logger: { warn: (m) => warned.push(m) }
      },
      { tool: 'codex', reason: ADAPTER_ERROR, error: 'boom' }
    );
    assert.equal(sent, false);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /codex/);
  });

  it('strips the home directory out of the message before it leaves the machine', async () => {
    // Node quotes the whole path in a file error, and a folder name can be the most
    // sensitive thing on a work machine. The collector's business is *when* a tool was
    // used, never what it was used on.
    const { calls, fetchFn } = capture();
    await reportCollectorState(
      { apiUrl: 'https://example.test', apiKey: 'k', fetchFn, homeDir: '/Users/alice' },
      {
        tool: 'codex', reason: ADAPTER_ERROR,
        error: "ENOENT: open '/Users/alice/Projects/acme-merger/notes.jsonl'"
      }
    );
    const sent = calls[0].body.heartbeat.error;
    assert.equal(sent, "ENOENT: open '~/Projects/acme-merger/notes.jsonl'");
    assert.equal(sent.includes('alice'), false, 'the account name must not travel');
  });

  it('does nothing without credentials rather than posting to nowhere', async () => {
    const { calls, fetchFn } = capture();
    assert.equal(await reportCollectorState(
      { apiUrl: '', apiKey: 'k', fetchFn }, { tool: 'codex', reason: ADAPTER_ERROR }), false);
    assert.equal(await reportCollectorState(
      { apiUrl: 'https://x.test', apiKey: '', fetchFn }, { tool: 'codex', reason: ADAPTER_ERROR }),
    false);
    assert.equal(calls.length, 0);
  });
});

describe('redactHome', () => {
  it('replaces the home directory wherever it appears', () => {
    assert.equal(redactHome('read /home/vin/a and /home/vin/b', '/home/vin'),
      'read ~/a and ~/b');
  });

  it('handles a Windows home in either slash direction', () => {
    // The path in a Node error and the path in USERPROFILE do not always agree about
    // separators, and matching only one of them leaks the other.
    assert.equal(redactHome('C:\\Users\\Amy\\.codex\\x', 'C:\\Users\\Amy'), '~\\.codex\\x');
    assert.equal(redactHome('C:/Users/Amy/.codex/x', 'C:\\Users\\Amy'), '~/.codex/x');
  });

  it('does not leave a fragment behind when one home is a prefix of another', () => {
    // /home/vin and /home/vincent coexist. Replacing the shorter first leaves "~cent".
    assert.equal(redactHome('/home/vincent/x', '/home/vincent'), '~/x');
    const out = redactHome('/home/vincent/x', '/home/vin');
    assert.equal(out.includes('~cent'), false, `left a fragment: ${out}`);
  });

  it('leaves a message with no path in it alone', () => {
    assert.equal(redactHome('LLM upstream 502', '/home/vin'), 'LLM upstream 502');
  });

  it('does not treat a one-character or empty home as a match', () => {
    // A misconfigured environment can make homedir() '/' or ''. Replacing that would
    // shred every path in the message and produce a useless report.
    assert.equal(redactHome('/a/b/c', '/'), '/a/b/c');
    assert.equal(redactHome('/a/b/c', ''), '/a/b/c');
  });
});

describe('withAdapterDeadline', () => {
  // A throw is caught, logged and reported. A scan that never finishes is not: the loop
  // stays on that tool and the adapters behind it never run. One member's records show
  // exactly that shape — the first tool checking in every two hours, the four behind it
  // frozen on a date in July.

  it('passes a result through untouched when the work settles in time', async () => {
    const out = await withAdapterDeadline('codex', Promise.resolve({ sent: 3 }), 1000);
    assert.deepEqual(out, { sent: 3 });
  });

  it('lets a genuine failure through as itself, not as a timeout', async () => {
    const boom = new Error('unreadable');
    await assert.rejects(
      withAdapterDeadline('codex', Promise.reject(boom), 1000),
      (err) => err === boom && err.__adapterTimeout === undefined
    );
  });

  it('has a default deadline that is long enough to be a ceiling and short enough to fire',
    async () => {
      // Every assertion in this suite passes an explicit deadline, so none of them touch
      // the value the scanner actually runs with. A default nobody exercises is a default
      // that can be set to Infinity without a single test noticing — which is precisely
      // the "no ceiling at all" state this exists to leave.
      //
      // The bound is loose on purpose. The measured worst case is seconds; the scheduler's
      // own interval is two hours, and a deadline at or beyond that would let one run
      // overlap the next.
      assert.ok(Number.isFinite(ADAPTER_DEADLINE_MS));
      assert.ok(ADAPTER_DEADLINE_MS >= 60_000, 'too tight for a machine with long history');
      assert.ok(ADAPTER_DEADLINE_MS < 2 * 60 * 60 * 1000, 'runs must not be able to overlap');

      // And it is genuinely the default: a promise that never settles is still pending
      // well after a short deadline would have rejected it.
      let settled = false;
      const pending = withAdapterDeadline('codex', new Promise(() => {}));
      pending.catch(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(settled, false, 'the default must not be a few milliseconds');
    });

  it('rejects with a flagged error when the work never settles', async () => {
    await assert.rejects(
      withAdapterDeadline('codex', new Promise(() => {}), 20),
      (err) => {
        // A flag, not a message match. The reason code is chosen from this, and matching
        // on wording would pick the wrong code the day somebody rewrites the sentence.
        assert.equal(err.__adapterTimeout, true);
        assert.match(err.message, /codex/);
        return true;
      }
    );
  });
});

describe('the self-check does not read a failure notice as proof of success', () => {
  // Before v1.26.142 a crashed adapter left no heartbeat, so `not_recorded` fell out of
  // "the server has nothing". Now it leaves a fresh one. Without the two codes in
  // LOCAL_BLOCKERS the check would see a recent row from this machine and answer
  // `confirmed` — reporting the failure as the thing that proves it is fine.

  const serverTime = '2026-08-11T10:00:00.000Z';
  const freshRow = (tool) => ({
    tool, machine: 'LAPTOP-1', last_reported_at: '2026-08-11T09:59:00.000Z'
  });

  it('calls a crashed adapter blocked, despite its own fresh heartbeat', () => {
    const report = buildSelfCheckReport({
      machine: 'LAPTOP-1',
      scanned: [{ tool: 'codex', sent: 0, accepted: 0, sessions: 0, reason: ADAPTER_ERROR }],
      serverTools: [freshRow('codex')],
      serverTime
    });
    assert.equal(report.rows[0].verdict, 'blocked');
    assert.equal(report.ok, false);
    assert.equal(report.failures, 1);
  });

  it('does the same for a hang', () => {
    const report = buildSelfCheckReport({
      machine: 'LAPTOP-1',
      scanned: [{ tool: 'codex', sent: 0, accepted: 0, sessions: 0, reason: ADAPTER_TIMEOUT }],
      serverTools: [freshRow('codex')],
      serverTime
    });
    assert.equal(report.rows[0].verdict, 'blocked');
  });

  it('still confirms a tool that scanned cleanly', () => {
    // The guard above must not swallow the healthy case it sits next to.
    const report = buildSelfCheckReport({
      machine: 'LAPTOP-1',
      scanned: [{ tool: 'codex', sent: 4, accepted: 4, sessions: 0, reason: 'ok' }],
      serverTools: [freshRow('codex')],
      serverTime
    });
    assert.equal(report.rows[0].verdict, 'confirmed');
    assert.equal(report.ok, true);
  });
});

describe('what the server does with a failure heartbeat', () => {
  // Driving the real route with an injected query. A regex over the source passes whether
  // or not the statement does what it says.

  async function post(heartbeat) {
    const captured = [];
    const query = async (sql, params) => {
      captured.push({ sql, params });
      if (/FROM usage_tracking_exemption/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 0 };
    };
    const router = createEventsRouter({
      query,
      auth: (req, _res, next) => { req.user = { id: 7 }; next(); },
      recomputeDaily: async () => ({ skipped: true })
    });
    const app = express();
    app.use(express.json());
    app.use('/api/usage/events', router);

    await new Promise((resolve, reject) => {
      const req = {
        method: 'POST',
        url: '/api/usage/events', path: '/api/usage/events',
        headers: { 'content-type': 'application/json' },
        body: { events: [], heartbeat }
      };
      const res = {
        statusCode: 200, _headers: {},
        setHeader(k, v) { this._headers[k] = v; },
        getHeader(k) { return this._headers[k]; },
        status(c) { this.statusCode = c; return this; },
        json() { resolve(); }, send() { resolve(); }, end() { resolve(); }
      };
      try { app.handle(req, res, (e) => (e ? reject(e) : resolve())); } catch (e) { reject(e); }
    });

    return {
      beat: captured.find((c) => /INSERT INTO collector_heartbeat/.test(c.sql)),
      audit: captured.find((c) => /INSERT INTO usage_audit_log/.test(c.sql))
    };
  }

  it('stores adapter_error in the reason column', async () => {
    const { beat } = await post({
      tool: 'codex', reason: ADAPTER_ERROR, machine: 'LAPTOP-1', error: 'boom'
    });
    assert.ok(beat, 'the heartbeat must still be written');
    assert.ok(beat.params.includes(ADAPTER_ERROR));
  });

  it('writes one collector_error audit row carrying the message', async () => {
    const { audit } = await post({
      tool: 'codex', reason: ADAPTER_ERROR, machine: 'LAPTOP-1',
      scanner_version: '1.26.142', error: 'EACCES: permission denied'
    });
    assert.ok(audit, 'the message has to land somewhere queryable');
    assert.ok(audit.params.includes('collector_error'));
    // writeAudit passes the details as a JSON string bound to a ::jsonb parameter.
    const details = JSON.parse(audit.params[audit.params.length - 1]);
    assert.equal(details.message, 'EACCES: permission denied');
    assert.equal(details.reason, ADAPTER_ERROR);
    assert.equal(details.machine, 'LAPTOP-1');
    assert.equal(details.scanner_version, '1.26.142');
  });

  it('truncates the message so a machine failing every two hours cannot fill the table',
    async () => {
      const { audit } = await post({
        tool: 'codex', reason: ADAPTER_TIMEOUT, machine: 'M', error: 'x'.repeat(4000)
      });
      // writeAudit passes the details as a JSON string bound to a ::jsonb parameter.
    const details = JSON.parse(audit.params[audit.params.length - 1]);
      assert.equal(details.message.length, 1000);
    });

  it('writes no audit row for a reason that does not mean the collector broke', async () => {
    // Letting any heartbeat carry free text in here would turn the audit table back into
    // the log file this change exists to replace.
    const { audit, beat } = await post({
      tool: 'codex', reason: 'no_new_activity', machine: 'M', error: 'not an error'
    });
    assert.ok(beat, 'the heartbeat itself is unaffected');
    assert.equal(audit, undefined);
  });

  it('writes no audit row when the failure arrives without a message', async () => {
    const { audit } = await post({ tool: 'codex', reason: ADAPTER_ERROR, machine: 'M' });
    assert.equal(audit, undefined);
  });

  it('stores nothing in the reason column for an unrecognised code', async () => {
    const { beat, audit } = await post({ tool: 'codex', reason: 'banana', error: 'boom' });
    assert.ok(beat);
    assert.equal(beat.params.includes('banana'), false);
    assert.equal(audit, undefined);
  });
});
