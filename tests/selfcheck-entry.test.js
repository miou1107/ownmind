// v1.26.72 — the entry point run at the end of an install, and by hand when diagnosing.
//
// Two properties matter more than the happy path:
//   - it must never fail an installation, whatever the network does
//   - it must exit non-zero when a tool is genuinely not reaching the server, because
//     every layer above reads exit codes and a diagnostic that exits 0 has said nothing

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { runSelfCheck } = await import('../hooks/ownmind-selfcheck.js');

const NOW = '2026-08-06T00:00:00.000Z';
const MACHINE = 'Vincent.local';

const okScan = () => ({
  machine: MACHINE,
  scannerVersion: '1.26.72',
  scanned: [{ tool: 'claude-code', sent: 3, accepted: 3, sessions: 0, reason: 'ok' }]
});

const okServer = (over = {}) => ({
  ok: true,
  data: {
    server_time: NOW,
    server_version: '1.26.72',
    tools: [{
      tool: 'claude-code', machine: MACHINE, os: 'darwin', scanner_version: '1.26.72',
      last_reported_at: '2026-08-05T23:59:30.000Z', reason: 'ok', events_24h: 3
    }],
    ...over
  }
});

function run(opts = {}) {
  const printed = [];
  return runSelfCheck({
    scan: opts.scan ?? (async () => okScan()),
    fetch: opts.fetch ?? (async () => okServer()),
    credentials: opts.credentials ?? (() => ({ apiUrl: 'https://x', apiKey: 'om_live_abc123456789' })),
    print: (s) => printed.push(s),
    ...opts.extra
  }).then((r) => ({ ...r, text: printed.join('\n') }));
}

describe('the happy path', () => {
  it('exits 0 and says the server has the data', async () => {
    const r = await run();
    assert.equal(r.exitCode, 0);
    assert.match(r.text, /claude-code/);
    assert.match(r.text, /OK/);
  });
});

describe('it never fails the installation', () => {
  it('survives the server being unreachable', async () => {
    const r = await run({ fetch: async () => ({ ok: false, error: 'connect ECONNREFUSED' }) });
    assert.equal(r.exitCode, 0, 'an unreachable server is not a reason to fail an install');
    assert.match(r.text, /ECONNREFUSED|could not/i);
  });

  it('survives a scan that throws', async () => {
    const r = await run({ scan: async () => { throw new Error('lock held'); } });
    assert.equal(r.exitCode, 0);
    assert.match(r.text, /lock held/);
  });

  it('survives missing credentials', async () => {
    const r = await run({ credentials: () => ({ apiUrl: null, apiKey: null }) });
    assert.equal(r.exitCode, 0);
    assert.match(r.text, /settings\.json|credential/i);
  });

  it('survives another scan already running', async () => {
    // main() returns undefined when it cannot take the lock.
    const r = await run({ scan: async () => undefined });
    assert.equal(r.exitCode, 0);
    assert.match(r.text, /already running|another/i);
  });
});

describe('it exits non-zero when something is genuinely wrong', () => {
  it('fails when the server has no recent record from this machine', async () => {
    const r = await run({ fetch: async () => okServer({ tools: [] }) });
    assert.equal(r.exitCode, 1);
    assert.match(r.text, /FAIL/);
  });

  it('fails when a tool could not be read on this machine', async () => {
    const r = await run({
      scan: async () => ({
        machine: MACHINE, scannerVersion: '1.26.72',
        scanned: [{ tool: 'cursor', sent: 0, accepted: 0, sessions: 0, reason: 'sqlite_missing' }]
      }),
      fetch: async () => okServer({ tools: [] })
    });
    assert.equal(r.exitCode, 1);
    assert.match(r.text, /sqlite3/i);
  });

  it('does not fail merely because another computer owns the row', async () => {
    const r = await run({
      fetch: async () => okServer({
        tools: [{
          tool: 'claude-code', machine: 'TANK', os: 'win32', scanner_version: '1.26.72',
          last_reported_at: '2026-08-05T23:59:30.000Z', reason: 'ok', events_24h: 3
        }]
      })
    });
    assert.equal(r.exitCode, 0);
    assert.match(r.text, /TANK/);
    assert.match(r.text, /WARN/);
  });
});

describe('what it prints', () => {
  it('does not mangle an error message that happens to contain key characters', async () => {
    // Redacting by substring on a short key turns "lock held" into "loc*** held" and
    // hides the actual error, which is the opposite of what this file is for.
    const r = await run({
      credentials: () => ({ apiUrl: 'https://x', apiKey: 'k' }),
      scan: async () => { throw new Error('lock held'); }
    });
    assert.match(r.text, /lock held/);
  });

  it('never prints the api key', async () => {
    const r = await run({ credentials: () => ({ apiUrl: 'https://x', apiKey: 'sk-secret-42' }) });
    assert.doesNotMatch(r.text, /sk-secret-42/);
  });

  it('never prints the api key even when the fetch fails with it in the message', async () => {
    const r = await run({
      credentials: () => ({ apiUrl: 'https://x', apiKey: 'sk-secret-42' }),
      fetch: async () => ({ ok: false, error: 'request to https://x?key=sk-secret-42 failed' })
    });
    assert.doesNotMatch(r.text, /sk-secret-42/);
  });
});
