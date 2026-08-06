// v1.26.72 — the ninth check: did this machine's usage data actually reach the server.
//
// `self-check.cjs` has run at the end of every install since v1.17.63, and its eight
// checks all ask "is everything installed and can I authenticate". None of them asks the
// question that every collector defect of the past week turned on: **is the data
// arriving**. Bob's case was a scheduler that never registered; the cases since were
// scanners that ran, reported success, and sent nothing.
//
// So this check runs a scan and then reads back from the server, rather than trusting the
// POST's own response. "The request succeeded" and "the server holds my data" are
// different claims, and only the second one is worth printing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selfCheck = require(path.join(repoRoot, 'scripts/install-helpers/self-check.cjs'));

const NOW = '2026-08-06T00:00:00.000Z';
const MACHINE = 'Vincent.local';

const scanOk = async () => ({
  machine: MACHINE,
  scannerVersion: '1.26.72',
  scanned: [{ tool: 'claude-code', sent: 3, accepted: 3, sessions: 0, reason: 'ok' }]
});

const serverOk = (tools) => async () => ({
  ok: true,
  data: {
    server_time: NOW,
    server_version: '1.26.72',
    tools: tools ?? [{
      tool: 'claude-code', machine: MACHINE, os: 'darwin', scanner_version: '1.26.72',
      last_reported_at: '2026-08-05T23:59:30.000Z', reason: 'ok', events_24h: 3
    }]
  }
});

const run = (over = {}) => selfCheck.checkUsageRoundtrip({
  apiUrl: 'https://x', apiKey: 'om_live_abc123456789',
  scan: scanOk, fetchSelfCheck: serverOk(), ...over
});

describe('the usage round-trip check', () => {
  it('passes when the server confirms this machine', async () => {
    const c = await run();
    assert.equal(c.status, 'pass');
    assert.equal(c.name, 'usage_roundtrip');
  });

  it('fails when the server has no recent record from this machine', async () => {
    // The state that used to look identical to health, in every layer, for eleven weeks.
    const c = await run({ fetchSelfCheck: serverOk([]) });
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /claude-code/);
    assert.ok(c.fix, 'a failure has to say what to do next');
  });

  it('fails and names the local cause when a tool could not be read', async () => {
    const c = await run({
      scan: async () => ({
        machine: MACHINE, scannerVersion: '1.26.72',
        scanned: [{ tool: 'cursor', sent: 0, accepted: 0, sessions: 0, reason: 'sqlite_missing' }]
      }),
      fetchSelfCheck: serverOk([])
    });
    assert.equal(c.status, 'fail');
    assert.match(`${c.detail} ${c.fix}`, /sqlite3/i);
  });

  it('warns without crashing when the row cannot say which computer wrote it', async () => {
    // The `other_machine` branch used to reach for `.find(...).server_machine`, which is
    // undefined when the only warning is an unattributed row. safeCheck would have turned
    // that TypeError into a `fail`, reporting a broken collector on a healthy machine.
    const c = await run({
      fetchSelfCheck: serverOk([{
        tool: 'claude-code', machine: null, os: 'darwin', scanner_version: '1.26.72',
        last_reported_at: '2026-08-05T23:59:30.000Z', reason: 'ok', events_24h: 3
      }])
    });
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /which computer|attribut/i);
  });

  it('warns, and does not fail, when another computer owns the row', async () => {
    // The events reached the right account; only the attribution is lost. Failing would
    // send someone to debug a machine that is working.
    const c = await run({
      fetchSelfCheck: serverOk([{
        tool: 'claude-code', machine: 'TANK', os: 'win32', scanner_version: '1.26.72',
        last_reported_at: '2026-08-05T23:59:30.000Z', reason: 'ok', events_24h: 3
      }])
    });
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /TANK/);
  });
});

describe('it can never break an install', () => {
  it('warns rather than failing when there are no credentials', async () => {
    const c = await run({ apiKey: null, apiUrl: null });
    assert.equal(c.status, 'warn');
  });

  it('warns when the server is too old to answer', async () => {
    const c = await run({
      fetchSelfCheck: async () => ({ ok: false, error: 'this server does not have the self-check endpoint yet' })
    });
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /self-check endpoint/);
  });

  it('warns when the server cannot be reached', async () => {
    const c = await run({ fetchSelfCheck: async () => ({ ok: false, error: 'connect ECONNREFUSED' }) });
    assert.equal(c.status, 'warn');
  });

  it('warns when another scan holds the lock', async () => {
    const c = await run({ scan: async () => undefined });
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /already running|another/i);
  });

  it('does not throw when the scan throws', async () => {
    const c = await run({ scan: async () => { throw new Error('boom'); } });
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /boom/);
  });

  it('gives up rather than hanging the installer', async () => {
    // A first scan on a machine with a long history is the slow case, and it is also the
    // one somebody is waiting on. Bounded, and it says so.
    const c = await run({
      scan: () => new Promise((resolve) => setTimeout(resolve, 5000)),
      timeoutMs: 30
    });
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /too long|timed out/i);
  });
});

describe('what it puts in the uploaded report', () => {
  it('never includes the api key', async () => {
    const c = await run({
      apiKey: 'om_live_supersecret42',
      fetchSelfCheck: async () => ({ ok: false, error: 'https://x?key=om_live_supersecret42 refused' })
    });
    assert.doesNotMatch(JSON.stringify(c), /supersecret42/);
  });

  it('carries the per-tool verdicts, so the server can see them without asking', async () => {
    const c = await run();
    assert.ok(Array.isArray(c.tools));
    assert.equal(c.tools[0].tool, 'claude-code');
    assert.equal(c.tools[0].verdict, 'confirmed');
  });

  it('is wired into the run', () => {
    // A check nobody calls is not a check.
    const src = require('node:fs')
      .readFileSync(path.join(repoRoot, 'scripts/install-helpers/self-check.cjs'), 'utf8');
    assert.match(src, /safeCheck\('usage_roundtrip'/);
  });
});
