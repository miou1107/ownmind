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
const { evaluateSilence } = await import('../src/lib/collector-silence.js');
const { renderMemberMessage, renderAdminMessage } =
  await import('../src/lib/collector-silence-message.js');

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

  it('matches regardless of case, because Windows paths do', () => {
    // Review finding. USERPROFILE and the path quoted in a Node error do not always agree
    // about case — a drive letter alone can differ — and a case-sensitive match would send
    // the account name through unredacted on the platform where it is most likely to differ.
    assert.equal(redactHome("open 'c:\\users\\Amy\\.codex\\x'", 'C:\\Users\\Amy'),
      "open '~\\.codex\\x'");
    assert.equal(redactHome('/Users/Alice/p', '/users/alice'), '~/p');
  });

  it('reaches the encoded project directory, not just the path prefix', () => {
    // Claude Code names each project directory after its path with the separators turned
    // into dashes. Redacting only the prefix left the account name sitting inside a path
    // that had already been "redacted" — the hardest place in the message to notice it.
    const out = redactHome(
      "ENOENT: open '/Users/alice/.claude/projects/-Users-alice-SourceCode-acme/x.jsonl'",
      '/Users/alice');
    assert.equal(out.includes('alice'), false, `account name survived: ${out}`);
    assert.match(out, /~\/\.claude\/projects\//, 'the diagnostic value is gone too');
  });

  it('stops at the punctuation an error message puts after a path', () => {
    assert.equal(redactHome('/Users/alice: permission denied', '/Users/alice'),
      '~: permission denied');
    assert.equal(redactHome('/Users/alice, and more', '/Users/alice'), '~, and more');
    assert.equal(redactHome('(/Users/alice)', '/Users/alice'), '(~)');
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

  // `heartbeatRowCount` is what the UPSERT reports having written. 1 is the ordinary case;
  // 0 is the statement's own rate limit suppressing a repeat, which the audit row has to
  // respect or it becomes a way around it.
  async function post(heartbeat, { heartbeatRowCount = 1 } = {}) {
    const captured = [];
    const query = async (sql, params) => {
      captured.push({ sql, params });
      if (/FROM usage_tracking_exemption/.test(sql)) return { rows: [] };
      if (/INSERT INTO collector_heartbeat/.test(sql)) {
        return { rows: [], rowCount: heartbeatRowCount };
      }
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

  it('writes no audit row when the heartbeat itself was rate-limited away', async () => {
    // Review finding. The UPSERT is rate-limited by its own WHERE clause; an audit write
    // that ignored that would be a route around the limit rather than a record of it, and
    // a machine stuck in a failure loop would fill the table. The UPSERT still writes
    // whenever the reason *changes*, so the first report of a failure always lands — it is
    // the repetitions inside the window that are dropped, which is what the window is for.
    const { beat, audit } = await post(
      { tool: 'codex', reason: ADAPTER_ERROR, machine: 'M', error: 'boom' },
      { heartbeatRowCount: 0 }
    );
    assert.ok(beat, 'the statement is still issued');
    assert.equal(audit, undefined, 'but nothing may be recorded for a suppressed beat');
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

describe('the scanner does not exit out from under its own reports (source reads)', () => {
  // These two read the file rather than run it, and that is a real weakness worth naming:
  // driving it for real would need credentials, a fake server and five live adapters. What
  // they pin is narrow but exact — that the collect-then-await pair is present and that the
  // explicit exit is there — and both would fail the day somebody restores the simpler
  // fire-and-forget version. The behaviour they stand in for is described here so the next
  // person can decide whether it has become worth the harness.
  // The direct-run handler calls process.exit(0) as soon as main() resolves. It has to: a
  // wedged adapter's handle would otherwise keep the process alive forever, and the
  // scheduler would stack another one next to it every two hours.
  //
  // An exit cuts every request still in flight. The upgrade's own events — did it happen,
  // did it fail, at which step — are exactly the ones that matter on the machines nobody
  // is watching, so firing them and forgetting them would remove the observability this
  // change exists to add.

  it('waits for the upgrade reports it started before returning', async () => {
    const source = await import('node:fs')
      .then((m) => m.readFileSync('hooks/ownmind-usage-scanner.js', 'utf8'));
    const fn = source.slice(source.indexOf('async function maybeUpgrade'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /inFlight\.push\(\s*postActivityEvent/,
      'the activity events are fired and forgotten, so the exit will cut them');
    assert.match(body, /await Promise\.allSettled\(inFlight\)/,
      'nothing waits for them');
    assert.match(body, /finally\s*\{[\s\S]*allSettled/,
      'an upgrade that failed must still get its failure reported before the process goes');
  });

  it('exits explicitly on success rather than waiting for the event loop', async () => {
    const source = await import('node:fs')
      .then((m) => m.readFileSync('hooks/ownmind-usage-scanner.js', 'utf8'));
    assert.match(source, /\.then\(\(\) => \{ process\.exit\(0\); \}\)/,
      'a hung adapter leaves a live handle; without this the process never ends');
  });
});

describe('a failure heartbeat must not switch off the alert that finds it', () => {
  // The sharpest finding of the review round, and the one that would have made this whole
  // release a net loss.
  //
  // `evaluateSilence` detects a dead collector by disagreement inside one machine: some
  // tools fresh, others frozen. That worked precisely because a broken adapter stopped
  // writing rows. Since this release it writes one every two hours saying it failed — so
  // without this, every broken collector looks permanently fresh, and the machine that
  // prompted the change (one tool current, four frozen in July) would show five current
  // rows and raise nothing at all.

  const NOW = new Date('2026-08-11T09:00:00Z');
  const ago = (days) => new Date(NOW.getTime() - days * 86_400_000);
  const row = (tool, days, reason) => ({
    user_id: 1, user_name: 'Amiee', machine: 'LAPTOP-1',
    tool, last_reported_at: ago(days), reason
  });

  it('flags a tool that has been reporting adapter_error every two hours', () => {
    const { silences } = evaluateSilence({
      rows: [row('claude-code', 0, 'ok'), row('codex', 0, ADAPTER_ERROR)],
      now: NOW
    });
    assert.equal(silences.length, 1, 'a collector failing every run raised nothing');
    assert.equal(silences[0].stale_tools, 'codex');
    assert.deepEqual(silences[0].failing_tools, ['codex']);
  });

  it('flags a hung one the same way', () => {
    const { silences } = evaluateSilence({
      rows: [row('claude-code', 0, 'ok'), row('codex', 0, ADAPTER_TIMEOUT)],
      now: NOW
    });
    assert.equal(silences.length, 1);
  });

  it('says nothing about a tool the user deliberately skipped', () => {
    // Alerting every two hours on somebody's own setting is how an alert gets muted.
    const { silences } = evaluateSilence({
      rows: [row('claude-code', 0, 'ok'), row('codex', 0, SKIPPED_BY_CONFIG)],
      now: NOW
    });
    assert.deepEqual(silences, []);
  });

  it('still says nothing when every tool is healthy', () => {
    const { silences } = evaluateSilence({
      rows: [row('claude-code', 0, 'ok'), row('codex', 0, 'no_new_activity')],
      now: NOW
    });
    assert.deepEqual(silences, []);
  });

  it('does not treat a failing tool as evidence the machine is alive', () => {
    // Only the healthy rows may vouch for a machine. Otherwise one adapter crashing on
    // schedule would keep a machine that stopped weeks ago looking current.
    const { silences } = evaluateSilence({
      rows: [row('claude-code', 30, 'ok'), row('codex', 0, ADAPTER_ERROR)],
      now: NOW
    });
    assert.deepEqual(silences, [], 'a dark machine is a switched-off computer, not a fault');
  });

  it('still reports an ordinary long silence', () => {
    // The behaviour that already existed must survive the change.
    const { silences } = evaluateSilence({
      rows: [row('claude-code', 0, 'ok'), row('codex', 30, null)],
      now: NOW
    });
    assert.equal(silences.length, 1);
    assert.equal(silences[0].stale_days, 30);
    assert.deepEqual(silences[0].failing_tools, []);
  });

  it('tells the reader it is failing, not that it has been quiet for no days', () => {
    // "has not reported since today (0 days)" reads as a bug in the alert, and a reader
    // who spots one stops believing the rest of it.
    const { silences } = evaluateSilence({
      rows: [row('claude-code', 0, 'ok'), row('codex', 0, ADAPTER_ERROR)],
      now: NOW
    });
    const member = renderMemberMessage(silences);
    const admin = renderAdminMessage(silences);
    for (const [who, msg] of [['member', member], ['admin', admin]]) {
      assert.match(msg.body, /每次執行都失敗/, `${who} message does not say it is failing`);
      assert.doesNotMatch(msg.body, /0 天/, `${who} message claims a zero-day silence`);
    }
  });

  it('keeps the day-count wording for a genuine silence', () => {
    const { silences } = evaluateSilence({
      rows: [row('claude-code', 0, 'ok'), row('codex', 30, null)],
      now: NOW
    });
    assert.match(renderAdminMessage(silences).body, /已 30 天/);
    assert.doesNotMatch(renderAdminMessage(silences).body, /每次執行都失敗/);
  });
});

describe('the job asks the database for the column the detector needs', () => {
  // Both ends of this interface are easy to fake, and faking both is how a change like
  // this passes every test while doing nothing. `evaluateSilence` is tested above with
  // hand-built rows carrying `reason`; if the job's SELECT stops asking for that column,
  // every real row arrives with `reason: undefined`, `isCollectorFailure` answers false
  // for all of them, and the alert quietly goes back to being switched off — with the
  // suite still green.
  //
  // So this one runs the job with an injected query and checks what it actually asked for.

  it('selects reason, and its rows reach the detector', async () => {
    const { runCollectorSilenceAlerts } = await import('../src/jobs/collector-silence-alerts.js');
    const asked = [];
    const now = new Date('2026-08-11T09:00:00Z');
    const beat = (tool, reason) => ({
      user_id: 1, user_name: 'Amiee', machine: 'LAPTOP-1', tool,
      last_reported_at: now, reason
    });
    const query = async (sql) => {
      asked.push(sql);
      if (/FROM collector_heartbeat/.test(sql)) {
        return { rows: [beat('claude-code', 'ok'), beat('codex', ADAPTER_ERROR)] };
      }
      return { rows: [] };
    };
    const sightings = [];
    await runCollectorSilenceAlerts({
      query: async (sql, params) => {
        if (/INSERT INTO collector_silence_alert_state/.test(sql)) sightings.push(params);
        return query(sql, params);
      },
      withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
      now: () => now
    });

    const heartbeatSql = asked.find((s) => /FROM collector_heartbeat/.test(s));
    assert.ok(heartbeatSql, 'the job never read the heartbeats');
    assert.match(heartbeatSql, /\bh\.reason\b/,
      'the query does not ask for reason, so every row reaches the detector as undefined '
      + 'and a failing collector is indistinguishable from a healthy one');

    assert.equal(sightings.length, 1,
      'the failing collector was not recorded as a silence end to end');
    assert.equal(sightings[0][2], 'codex');
  });
});
