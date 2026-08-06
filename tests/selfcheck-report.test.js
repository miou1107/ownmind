// v1.26.72 — after an upgrade, the machine asks the server whether its data arrived.
//
// Every collector defect found this week had the same shape: the machine believed it was
// working, the server had nothing, and no layer said so. The evidence needed to diagnose
// it only ever existed on the machine with the problem, and nobody looked at it there.
//
// The scanner already sees an `accepted=` count come back from each batch it posts. That
// has never been enough. It says a request succeeded, not that the server ended up
// holding the data, and it says nothing at all on a run with nothing to send — which is
// every run on a machine that is broken.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { buildSelfCheckReport, renderSelfCheckReport, fetchSelfCheck } =
  await import('../shared/scanners/selfcheck.js');

const NOW = '2026-08-06T00:00:00.000Z';
const MACHINE = 'Vincent.local';

/** What a heartbeat row looks like coming back from the server. */
function beat(tool, over = {}) {
  return {
    tool,
    machine: MACHINE,
    os: 'darwin',
    scanner_version: '1.26.72',
    last_reported_at: '2026-08-05T23:59:30.000Z',
    reason: 'ok',
    events_24h: 12,
    ...over
  };
}

/** What one adapter's scan result looks like locally. */
function scan(tool, over = {}) {
  return { tool, sent: 3, accepted: 3, sessions: 0, reason: 'ok', ...over };
}

const report = (scanned, serverTools, over = {}) => buildSelfCheckReport({
  machine: MACHINE, scanned, serverTools, serverTime: NOW, ...over
});

const verdictOf = (r, tool) => r.rows.find((x) => x.tool === tool)?.verdict;

describe('the data arrived', () => {
  it('confirms a tool the server has from this machine, just now', () => {
    const r = report([scan('claude-code')], [beat('claude-code')]);
    assert.equal(verdictOf(r, 'claude-code'), 'confirmed');
    assert.equal(r.ok, true);
    assert.equal(r.failures, 0);
  });

  it('confirms a tool that had nothing new to send', () => {
    // Nothing new is the ordinary healthy case. The proof is the heartbeat, not events.
    const r = report(
      [scan('codex', { sent: 0, accepted: 0, reason: 'no_new_activity' })],
      [beat('codex', { events_24h: 0, reason: 'no_new_activity' })]
    );
    assert.equal(verdictOf(r, 'codex'), 'confirmed');
    assert.equal(r.ok, true);
  });
});

describe('nothing to report', () => {
  it('does not hold a missing tool against the machine', () => {
    const r = report(
      [scan('opencode', { sent: 0, reason: 'no_install' })],
      [beat('opencode', { reason: 'no_install', events_24h: 0 })]
    );
    assert.equal(verdictOf(r, 'opencode'), 'not_installed');
    assert.equal(r.ok, true);
    assert.equal(r.failures, 0);
  });

  it('says not_installed even when the server has never heard of the tool', () => {
    const r = report([scan('opencode', { sent: 0, reason: 'no_install' })], []);
    assert.equal(verdictOf(r, 'opencode'), 'not_installed');
    assert.equal(r.ok, true);
  });
});

describe('the data did not arrive', () => {
  it('fails when the server has no row at all for a tool this machine scanned', () => {
    const r = report([scan('claude-code')], []);
    assert.equal(verdictOf(r, 'claude-code'), 'not_recorded');
    assert.equal(r.ok, false);
    assert.equal(r.failures, 1);
  });

  it('fails when the row is older than the freshness window', () => {
    // A stale row means this run did not land. Without the window, any row ever written
    // would read as proof, and a collector that died months ago would pass.
    const r = report(
      [scan('claude-code')],
      [beat('claude-code', { last_reported_at: '2026-08-05T20:00:00.000Z' })]
    );
    assert.equal(verdictOf(r, 'claude-code'), 'not_recorded');
    assert.equal(r.ok, false);
  });

  it('measures freshness against the server clock, not this machine', () => {
    // A machine with a wrong clock would otherwise report a healthy collector broken,
    // or a dead one healthy, and it is exactly the machine you cannot ask.
    const r = buildSelfCheckReport({
      machine: MACHINE,
      scanned: [scan('claude-code')],
      serverTools: [beat('claude-code', { last_reported_at: '2026-08-05T23:59:30.000Z' })],
      serverTime: '2026-08-06T00:00:00.000Z',
      now: new Date('2019-01-01T00:00:00.000Z')   // this machine's clock is nonsense
    });
    assert.equal(verdictOf(r, 'claude-code'), 'confirmed');
  });
});

describe('the machine could not read the tool', () => {
  for (const reason of ['unreadable', 'sqlite_missing']) {
    it(`fails on ${reason} and says the problem is local`, () => {
      const r = report(
        [scan('cursor', { sent: 0, reason })],
        [beat('cursor', { reason, events_24h: 0 })]
      );
      assert.equal(verdictOf(r, 'cursor'), 'blocked');
      assert.equal(r.ok, false);
      assert.equal(r.rows.find((x) => x.tool === 'cursor').reason, reason);
    });
  }

  it('is blocked rather than not_recorded even when the server has no row', () => {
    // The machine knows why it sent nothing. Reporting "the server did not get it" would
    // send someone to look at the network.
    const r = report([scan('cursor', { sent: 0, reason: 'sqlite_missing' })], []);
    assert.equal(verdictOf(r, 'cursor'), 'blocked');
  });
});

describe('another computer owns the row', () => {
  it('warns rather than fails', () => {
    // The events did reach the right account. What is lost is knowing which computer
    // they came from. Failing here would send someone to debug a working machine.
    const r = report([scan('claude-code')], [beat('claude-code', { machine: 'TANK' })]);
    assert.equal(verdictOf(r, 'claude-code'), 'other_machine');
    assert.equal(r.ok, true, 'a warning must not fail the check');
    assert.equal(r.warnings, 1);
    assert.equal(r.failures, 0);
  });

  it('names the other computer, because that is the actionable part', () => {
    const r = report([scan('claude-code')], [beat('claude-code', { machine: 'TANK' })]);
    assert.equal(r.rows.find((x) => x.tool === 'claude-code').server_machine, 'TANK');
  });

  it('compares machine names case-insensitively and ignores surrounding space', () => {
    // Windows reports the hostname upper-cased in some paths; the same computer must not
    // read as two.
    const r = report([scan('claude-code')], [beat('claude-code', { machine: ' VINCENT.LOCAL ' })]);
    assert.equal(verdictOf(r, 'claude-code'), 'confirmed');
  });

  it('will not confirm against a row that cannot say which machine wrote it', () => {
    // This used to return `confirmed`, on the reasoning that "unknown is not someone
    // else". That reasoning produces the one outcome this whole change exists to
    // prevent: with UNIQUE (user_id, tool) there is a single row per tool, so a fresh
    // row with no machine name is indistinguishable from another computer's — and a
    // machine whose upload is silently failing would read its neighbour's heartbeat as
    // proof of its own success.
    const r = report([scan('claude-code')], [beat('claude-code', { machine: null })]);
    assert.equal(verdictOf(r, 'claude-code'), 'unattributed');
    assert.equal(r.ok, true, 'unknown attribution is not a failure either');
    assert.equal(r.warnings, 1);
  });

  it('says so in words rather than leaving the reader to guess', () => {
    const text = renderSelfCheckReport(
      report([scan('claude-code')], [beat('claude-code', { machine: null })])
    );
    assert.match(text, /WARN/);
    assert.match(text, /which computer|attribut/i);
  });
});

describe('the whole report', () => {
  it('keeps one row per tool the machine scanned, in scan order', () => {
    const r = report(
      [scan('claude-code'), scan('codex'), scan('cursor')],
      [beat('claude-code'), beat('codex'), beat('cursor')]
    );
    assert.deepEqual(r.rows.map((x) => x.tool), ['claude-code', 'codex', 'cursor']);
  });

  it('ignores server rows for tools this machine did not scan', () => {
    // OWNMIND_SKIP_TOOLS, or a tool this machine never had. The server holding a row
    // from another computer is not this machine's business to report on.
    const r = report([scan('claude-code')], [beat('claude-code'), beat('opencode')]);
    assert.equal(r.rows.length, 1);
  });

  it('fails overall if any single tool failed', () => {
    const r = report(
      [scan('claude-code'), scan('codex')],
      [beat('claude-code')]           // codex missing
    );
    assert.equal(r.ok, false);
    assert.equal(r.failures, 1);
  });

  it('survives a scan that produced nothing at all', () => {
    const r = report([], []);
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 0);
  });
});

describe('what the person reading the installer sees', () => {
  it('gives every tool one line', () => {
    const text = renderSelfCheckReport(report(
      [scan('claude-code'), scan('codex')],
      [beat('claude-code'), beat('codex')]
    ));
    assert.equal(text.split('\n').filter((l) => l.includes('claude-code')).length, 1);
    assert.equal(text.split('\n').filter((l) => l.includes('codex')).length, 1);
  });

  it('tells someone what to do next when a tool fails', () => {
    const text = renderSelfCheckReport(report([scan('claude-code')], []));
    assert.match(text, /claude-code/);
    // Not a status word on its own: a failure has to carry an instruction.
    assert.ok(text.length > 'claude-code not_recorded'.length * 2,
      'a failure line must say more than the verdict name');
  });

  it('does not print an api key or a url with one in it', () => {
    const text = renderSelfCheckReport(report([scan('claude-code')], [beat('claude-code')]));
    assert.doesNotMatch(text, /api[_-]?key/i);
  });
});

describe('asking the server', () => {
  const KEY = 'om_live_supersecret42';

  it('keeps the key out of its own error, not only out of the caller\'s', () => {
    // Measured, not assumed: a key containing a newline makes fetch throw
    //   Headers.append: "om_live_...\n..." is an invalid header value
    // — the message carries the key verbatim. Both current callers redact, but the
    // value is known here and nowhere else guarantees the next caller will.
    return fetchSelfCheck({
      apiUrl: 'https://x', apiKey: KEY,
      fetchFn: async () => { throw new Error(`Headers.append: "${KEY}" is invalid`); }
    }).then((r) => {
      assert.equal(r.ok, false);
      assert.doesNotMatch(r.error, /supersecret42/);
    });
  });

  it('redacts a key that appears in a url inside the error', async () => {
    const r = await fetchSelfCheck({
      apiUrl: 'https://x', apiKey: KEY,
      fetchFn: async () => { throw new Error('request to https://x?api_key=abc123 failed'); }
    });
    assert.doesNotMatch(r.error, /abc123/);
  });

  it('names an older server rather than saying the network failed', async () => {
    const r = await fetchSelfCheck({
      apiUrl: 'https://x', apiKey: KEY,
      fetchFn: async () => ({ ok: false, status: 404 })
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /self-check endpoint/);
  });

  // ──────────────────────────────────────────────────────────
  // v1.26.77 — the header the server actually reads
  // ──────────────────────────────────────────────────────────

  it('authenticates with the header the server reads', async () => {
    // Measured on production 2026-08-06, straight after the upgrade that installed this
    // check: "Could not ask the server: the server answered 401". The scan itself uploaded
    // fine. This call sent `X-API-Key`, and src/middleware/auth.js reads only
    // `Authorization: Bearer`. The self-check could never have succeeded against a server
    // that had the endpoint — v1.26.72 through v1.26.76 shipped it broken, and the one
    // real-world run before this had answered 404, which hid it.
    let seen = null;
    await fetchSelfCheck({
      apiUrl: 'https://x', apiKey: KEY,
      fetchFn: async (_url, opts) => { seen = opts?.headers ?? {}; return { ok: false, status: 500 }; }
    });
    const names = Object.keys(seen).map((k) => k.toLowerCase());
    assert.ok(names.includes('authorization'),
      `sent ${JSON.stringify(names)}; the server reads Authorization and nothing else`);
    assert.equal(seen.Authorization ?? seen.authorization, `Bearer ${KEY}`);
  });

  it('sends what the middleware parses, checked against the middleware itself', async () => {
    // The two sides were faked independently: this file stubs fetch, and the endpoint's
    // own tests stub auth. Neither could see that they disagreed. This reads the real
    // middleware so the pair cannot drift apart again.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const auth = fs.readFileSync(path.join(repoRoot, 'src/middleware/auth.js'), 'utf8');
    assert.match(auth, /req\.headers\.authorization/,
      'if the middleware stopped reading Authorization, this check is sending the wrong header');
    assert.match(auth, /startsWith\(\s*['"`]Bearer /,
      'the scheme the client sends must be the scheme the middleware requires');
  });
});
