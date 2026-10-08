// v1.32.0 — which server each machine reports to (issue #152).
//
// Two computers posted to the retired host kkvin.com for a week after the move. Every
// row they produced said 1.31.14 and nothing else; finding them meant reading nginx logs
// on the old host and matching a handoff number against session logs. Now the scanner's
// heartbeat carries the host part of the address it posts to, the server keeps it, and
// the admin list flags any computer whose host is not the server's own.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { startServer } from './helpers/app-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { apiHostOf, postBatch, reportCollectorState } = await import('../shared/scanners/base.js');
const { createEventsRouter, normaliseApiHost } = await import('../src/routes/usage/events.js');
const { loadClients, canonicalHostOf, createAdminClientsRouter } =
  await import('../src/routes/usage/admin-clients.js');
const { groupClientsByMachine } = await import('../client/src/pages/System/machine-groups.js');
const { runSelfCheck } = await import('../hooks/ownmind-selfcheck.js');

// ────────────────────────────────────────────────────────────
// The migration
// ────────────────────────────────────────────────────────────

describe('db/031 — the column', () => {
  const sql = fs.readFileSync(path.join(repoRoot, 'db', '031_collector_api_host.sql'), 'utf8');

  it('adds api_host as a nullable VARCHAR(255) and is safe to run twice', () => {
    assert.match(sql, /ALTER TABLE collector_heartbeat\s+ADD COLUMN IF NOT EXISTS api_host VARCHAR\(255\)/i);
    assert.doesNotMatch(sql, /api_host VARCHAR\(255\)\s+NOT NULL/i);
  });
});

// ────────────────────────────────────────────────────────────
// The scanner: host only, never the key or the path
// ────────────────────────────────────────────────────────────

describe('apiHostOf', () => {
  it('keeps the host and drops scheme, port, path, query and credentials', () => {
    assert.equal(apiHostOf('https://fapa.welcometw.com/ownmind'), 'fapa.welcometw.com');
    assert.equal(apiHostOf('https://user:secret@kkvin.com:8443/ownmind/?key=abc'), 'kkvin.com');
    assert.equal(apiHostOf('http://localhost:3000'), 'localhost');
  });
  it('lower-cases, so the server compares like with like', () => {
    assert.equal(apiHostOf('https://FAPA.WelcomeTW.com/ownmind'), 'fapa.welcometw.com');
  });
  it('yields null for anything that is not an address', () => {
    assert.equal(apiHostOf(''), null);
    assert.equal(apiHostOf('not a url'), null);
    assert.equal(apiHostOf(undefined), null);
  });
});

function captureFetch() {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ accepted: 0, duplicated: 0 }) };
  };
  return { calls, fetchFn };
}

describe('every heartbeat the scanner posts carries api_host', () => {
  it('postBatch adds it from the address it posts to', async () => {
    const { calls, fetchFn } = captureFetch();
    await postBatch(
      { apiUrl: 'https://kkvin.com/ownmind/', apiKey: 'k', fetchFn },
      { events: [], heartbeat: { tool: 'claude-code', machine: 'LAPTOP-1' } }
    );
    assert.equal(calls[0].body.heartbeat.api_host, 'kkvin.com');
    assert.equal(calls[0].body.heartbeat.machine, 'LAPTOP-1');
  });

  it('does not touch a payload that has no heartbeat', async () => {
    const { calls, fetchFn } = captureFetch();
    await postBatch({ apiUrl: 'https://kkvin.com/ownmind', apiKey: 'k', fetchFn },
      { events: [{ x: 1 }] });
    assert.deepEqual(calls[0].body, { events: [{ x: 1 }] });
  });

  it('reportCollectorState — the failure path — carries it too', async () => {
    const { calls, fetchFn } = captureFetch();
    await reportCollectorState(
      { apiUrl: 'https://fapa.welcometw.com/ownmind', apiKey: 'k', fetchFn },
      { tool: 'codex', reason: 'adapter_error', scannerVersion: '1.32.0', machine: 'M' }
    );
    assert.equal(calls[0].body.heartbeat.api_host, 'fapa.welcometw.com');
  });

  it('never sends the key, even when the address carries it', async () => {
    const { calls, fetchFn } = captureFetch();
    await postBatch(
      { apiUrl: 'https://kkvin.com/ownmind?key=SECRET', apiKey: 'SECRET', fetchFn },
      { events: [], heartbeat: { tool: 'claude-code' } }
    );
    assert.doesNotMatch(JSON.stringify(calls[0].body), /SECRET/);
  });
});

// ────────────────────────────────────────────────────────────
// The server: accept, bound, store; absent leaves the stored value alone
// ────────────────────────────────────────────────────────────

describe('normaliseApiHost', () => {
  it('accepts a host name and lower-cases it', () => {
    assert.equal(normaliseApiHost('Fapa.WelcomeTW.com'), 'fapa.welcometw.com');
    assert.equal(normaliseApiHost('  kkvin.com '), 'kkvin.com');
    assert.equal(normaliseApiHost('localhost'), 'localhost');
  });
  it('treats a URL, a path, a space or a key as "did not say"', () => {
    assert.equal(normaliseApiHost('https://kkvin.com'), null);
    assert.equal(normaliseApiHost('kkvin.com/ownmind'), null);
    assert.equal(normaliseApiHost('kkvin.com:443'), null);
    assert.equal(normaliseApiHost('two words'), null);
    assert.equal(normaliseApiHost(''), null);
    assert.equal(normaliseApiHost(42), null);
    assert.equal(normaliseApiHost(undefined), null);
  });
  it('bounds the length to the column', () => {
    assert.equal(normaliseApiHost('a'.repeat(255)), 'a'.repeat(255));
    assert.equal(normaliseApiHost('a'.repeat(256)), null);
  });
});

async function ingest(heartbeat) {
  const capture = [];
  const query = async (sql, params) => { capture.push({ sql, params }); return { rows: [], rowCount: 0 }; };
  const router = createEventsRouter({ query, auth: (req, _res, next) => { req.user = { id: 7 }; next(); } });
  const app = express();
  app.use(express.json());
  app.use('/api/usage/events', router);
  const server = await startServer(app);
  let status;
  try {
    const res = await fetch(`${server.url}/api/usage/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [], heartbeat })
    });
    status = res.status;
  } finally {
    await server.close();
  }
  const hb = capture.find((c) => /INSERT INTO collector_heartbeat/i.test(c.sql));
  return { status, hb };
}

describe('writing a heartbeat with api_host', () => {
  it('stores the host and lets it through the rate limit when it changed', async () => {
    const { status, hb } = await ingest({ tool: 'claude-code', machine: 'LAPTOP-1', api_host: 'kkvin.com' });
    assert.equal(status, 200);
    assert.ok(hb);
    assert.equal(hb.params[7], 'kkvin.com');
    assert.equal(hb.params[8], true);
    assert.match(hb.sql, /api_host\s*=\s*CASE WHEN \$9 THEN \$8 ELSE collector_heartbeat\.api_host END/);
    assert.match(hb.sql, /\$9 AND collector_heartbeat\.api_host IS DISTINCT FROM \$8/);
  });

  it('an older scanner that sends none leaves the stored value alone', async () => {
    const { status, hb } = await ingest({ tool: 'claude-code', machine: 'LAPTOP-1' });
    assert.equal(status, 200);
    assert.equal(hb.params[7], null);
    assert.equal(hb.params[8], false, 'absent must not be written as null');
  });

  it('an odd value is ignored, not rejected: the heartbeat still lands', async () => {
    const { status, hb } = await ingest({ tool: 'claude-code', machine: 'M', api_host: 'https://kkvin.com/ownmind?key=x' });
    assert.equal(status, 200);
    assert.ok(hb, 'the heartbeat must still be written');
    assert.equal(hb.params[7], null);
    assert.equal(hb.params[8], false);
  });

  it('the new parameter in the INSERT ... SELECT list carries an explicit type', async () => {
    const { hb } = await ingest({ tool: 'claude-code', machine: 'M', api_host: 'kkvin.com' });
    assert.match(hb.sql, /\$8::varchar/);
  });
});

// ────────────────────────────────────────────────────────────
// The admin list: api_host and on_old_host
// ────────────────────────────────────────────────────────────

const row = (user_id, machine, api_host, over = {}) => ({
  user_id, user_name: `U${user_id}`, email: `u${user_id}@x.com`, role: 'user',
  tool: 'claude-code', scanner_version: '1.32.0', machine, os: 'win32',
  last_reported_at: new Date().toISOString(), reason: 'ok', api_host, ...over
});

describe('canonicalHostOf', () => {
  it('reads the host out of CANONICAL_URL', () => {
    assert.equal(canonicalHostOf('https://fapa.welcometw.com/ownmind'), 'fapa.welcometw.com');
  });
  it('is null when the variable is unset or not an address', () => {
    assert.equal(canonicalHostOf(''), null);
    assert.equal(canonicalHostOf(undefined), null);
    assert.equal(canonicalHostOf('nope'), null);
  });
});

describe('loadClients — on_old_host', () => {
  const query = async () => ({ rows: [
    row(1, 'LAPTOP-G95HIQ3V', 'kkvin.com'),
    row(2, 'TANK', 'fapa.welcometw.com'),
    row(3, 'OLD-MAC', null)
  ] });

  it('flags the computer whose host is not the canonical one, and only that one', async () => {
    const data = await loadClients({ query, serverVersion: '1.32.0', now: new Date(), canonicalHost: 'fapa.welcometw.com' });
    const byId = new Map(data.users.map((u) => [u.user_id, u]));
    assert.equal(byId.get(1).clients[0].api_host, 'kkvin.com');
    assert.equal(byId.get(1).clients[0].on_old_host, true);
    assert.equal(byId.get(1).on_old_host, true);
    assert.equal(byId.get(2).clients[0].on_old_host, false);
    assert.equal(byId.get(2).on_old_host, false);
    // A scanner that cannot say is not accused of anything.
    assert.equal(byId.get(3).clients[0].api_host, null);
    assert.equal(byId.get(3).clients[0].on_old_host, false);
    assert.equal(data.coverage.on_old_host, 1);
  });

  it('flags nobody when the server has no canonical host of its own', async () => {
    const data = await loadClients({ query, serverVersion: '1.32.0', now: new Date(), canonicalHost: null });
    assert.ok(data.users.every((u) => u.on_old_host === false));
    assert.equal(data.coverage.on_old_host, 0);
  });

  it('the router reads CANONICAL_URL per request', async () => {
    const router = createAdminClientsRouter({
      query, adminAuth: (req, _res, next) => { req.user = { id: 1, role: 'admin' }; next(); },
      serverVersion: '1.32.0', canonicalUrl: () => 'https://fapa.welcometw.com/ownmind'
    });
    const app = express();
    app.use('/api/usage/admin/clients', router);
    const server = await startServer(app);
    try {
      const data = await (await fetch(`${server.url}/api/usage/admin/clients`)).json();
      assert.equal(data.coverage.on_old_host, 1);
      assert.equal(data.users.find((u) => u.user_id === 1).clients[0].on_old_host, true);
    } finally {
      await server.close();
    }
  });
});

// ────────────────────────────────────────────────────────────
// The console: one host per computer
// ────────────────────────────────────────────────────────────

describe('groupClientsByMachine — api_host', () => {
  const c = (over = {}) => ({
    tool: 'claude-code', version: '1.32.0', machine: 'LAPTOP-1', os: 'win32',
    status: 'active', last_heartbeat_at: '2026-10-08T00:00:00.000Z',
    needs_upgrade: false, reason: 'ok', api_host: null, on_old_host: false, ...over
  });

  it('carries the host and the flag up to the computer', () => {
    const [g] = groupClientsByMachine([
      c({ tool: 'claude-code', api_host: 'kkvin.com', on_old_host: true }),
      c({ tool: 'codex', api_host: 'kkvin.com', on_old_host: true })
    ]);
    assert.equal(g.api_host, 'kkvin.com');
    assert.equal(g.on_old_host, true);
  });

  it('takes the host from whichever tool reported it', () => {
    const [g] = groupClientsByMachine([c({ tool: 'codex' }), c({ tool: 'claude-code', api_host: 'fapa.welcometw.com' })]);
    assert.equal(g.api_host, 'fapa.welcometw.com');
    assert.equal(g.on_old_host, false);
  });

  it('leaves it null for a computer whose scanner is too old to say', () => {
    const [g] = groupClientsByMachine([c()]);
    assert.equal(g.api_host, null);
    assert.equal(g.on_old_host, false);
  });
});

describe('the console copy for the column', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client/src/i18n/zh.json'), 'utf8'));
  it('names the column and the red pill, and the pill says what to do', () => {
    assert.equal(zh['system.config.col.api_host'], '連的主機');
    assert.equal(zh['system.config.api_host.old_host'], '連到舊主機');
    assert.match(zh['system.config.api_host.old_host_hint'], /升級 OwnMind/);
    assert.match(zh['system.config.api_host.old_host_hint'], /自檢/);
  });
  it('is present in every language the console ships', () => {
    for (const lang of ['en', 'ja']) {
      const d = JSON.parse(fs.readFileSync(path.join(repoRoot, `client/src/i18n/${lang}.json`), 'utf8'));
      for (const k of ['system.config.col.api_host', 'system.config.api_host.unknown',
        'system.config.api_host.old_host', 'system.config.api_host.old_host_hint',
        'system.config.overall.old_host']) {
        assert.ok(d[k], `${lang} is missing ${k}`);
      }
    }
  });
});

// ────────────────────────────────────────────────────────────
// The self-check a member pastes to an admin says the host first
// ────────────────────────────────────────────────────────────

describe('the self-check names the server', () => {
  it('prints the host before scanning, so a pasted result answers #152 on its own', async () => {
    const lines = [];
    await runSelfCheck({
      credentials: () => ({ apiUrl: 'https://kkvin.com/ownmind', apiKey: 'k'.repeat(12) }),
      scan: async () => { throw new Error('stop here'); },
      fetch: async () => ({ ok: false, error: 'unused' }),
      print: (l) => lines.push(String(l))
    });
    assert.ok(lines.some((l) => l.includes('Server: kkvin.com')), lines.join('\n'));
  });
});
