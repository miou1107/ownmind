import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { tempDir } from './helpers/temp-dir.js';

/**
 * v1.17.99 — mcp/ownmind-log.js logEvent must generate a client_event_id per event.
 *
 * Why:
 *   v1.17.98 server uses a (user_id, client_event_id) partial unique index for dedup.
 *   v1.17.96/97 reply-lint hook already sends an id, but mcp/ownmind-log.js logEvent
 *   did not → server fell back to the NULL path for logEvent, sufficient but with no
 *   dedup protection.
 *
 *   v1.17.99 also adds client_event_id to logEvent so every client path dedups consistently.
 *
 * Note: mcp/ownmind-log.js uses fetch (node-fetch) to call the server with API_URL/KEY
 * injected via env vars, and the buffer logic is non-trivial (three triggers:
 * 10 events / 30s / IMMEDIATE_FLUSH_EVENTS). This test only verifies that the JSONL
 * entry written by logEvent and the events in the POST body both carry a UUID v4.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let tmpHome;
let logsDir;
let captured;
let fakeServer;
let serverPort;

async function startFakeServer() {
  return new Promise((resolve) => {
    fakeServer = http.createServer((req, res) => {
      let buf = '';
      req.on('data', c => buf += c);
      req.on('end', () => {
        try { captured.push(JSON.parse(buf)); } catch { captured.push({ _raw: buf }); }
        res.statusCode = 200; res.end('{"inserted":0,"deduped":0,"total":0,"auto_observed":0}');
      });
    });
    fakeServer.listen(0, '127.0.0.1', () => {
      serverPort = fakeServer.address().port;
      resolve();
    });
  });
}

function setup() {
  tmpHome = tempDir('ownmind-log-uuid-test-');
  logsDir = path.join(tmpHome, '.ownmind', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  captured = [];
}

function cleanup() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  // I2 — every cachebust import registers a new process.on('beforeExit'/'SIGINT'/'SIGTERM')
  // listener, so they pile up to MaxListenersExceededWarning. Clear the ones added in this
  // test at teardown. Without cleanup, process exit triggers multiple fetches (fakeServer is
  // already closed, so it just silent-fails).
  for (const sig of ['beforeExit', 'SIGINT', 'SIGTERM']) {
    process.removeAllListeners(sig);
  }
}

/**
 * I4 — setTimeout-flaky workaround: poll captured.length until it reaches n or times out.
 */
async function waitForPosts(n, timeoutMs = 2000) {
  const start = Date.now();
  while (captured.length < n) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${n} POSTs, actual ${captured.length}`);
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

async function freshLogModule(env = {}) {
  // Force re-import so the latest env is applied.
  const mod = await import(`../mcp/ownmind-log.js?cachebust=${Date.now()}-${Math.random()}`);
  return mod;
}

// Same logic exported from ownmind-log.js — sharing the source avoids timezone drift.
const { localDateOnly } = await import('../mcp/ownmind-log.js');

describe('v1.17.99 — mcp/ownmind-log.js logEvent carries client_event_id', () => {
  beforeEach(async () => {
    setup();
    await startFakeServer();
    // logEvent reads HOME / API_URL / API_KEY from process.env, frozen at import time.
    process.env.HOME = tmpHome;
    process.env.OWNMIND_API_URL = `http://127.0.0.1:${serverPort}`;
    process.env.OWNMIND_API_KEY = 'fake-key';
    // I3 — hygiene: scrub the dev-machine OWNMIND_TOOL leftover (otherwise the first entry leaks it).
    process.env.OWNMIND_TOOL = 'test-claude-code';
  });
  afterEach(() => {
    fakeServer?.close();
    cleanup();
  });

  it('every entry written to the local JSONL carries a UUID v4 client_event_id', async () => {
    const { logEvent } = await freshLogModule();
    logEvent('memory_save', { rule_code: 'IR-001' });
    logEvent('memory_disable', { rule_code: 'IR-002' });

    // Wait for the local JSONL write (appendFileSync is sync).
    // Align with logEvent's local-time date (IR-032 timezone policy: avoid the
    // 8h gap between UTC and Taipei making the test pick the wrong filename across midnight).
    const today = localDateOnly(new Date());
    const file = path.join(logsDir, `${today}.jsonl`);
    assert.ok(fs.existsSync(file));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const ids = lines.map(l => JSON.parse(l).client_event_id);
    assert.ok(ids[0], 'event 1 must have a client_event_id');
    assert.ok(ids[1], 'event 2 must have a client_event_id');
    assert.match(ids[0], UUID_V4);
    assert.match(ids[1], UUID_V4);
    assert.notEqual(ids[0], ids[1], 'two events must have different ids (randomUUID is fresh each call)');
  });

  it('events array POSTed to server also carries client_event_id (buffer flush must not drop it)', async () => {
    const { logEvent } = await freshLogModule();
    // iron_rule_compliance is in IMMEDIATE_FLUSH_EVENTS, so it POSTs immediately.
    logEvent('iron_rule_compliance', { action: 'violate', rule_code: 'IR-037' });
    // Wait for the fetch to finish.
    await waitForPosts(1);
    assert.ok(captured.length >= 1, 'server should receive a POST');
    const body = captured[0];
    assert.ok(Array.isArray(body.events));
    assert.equal(body.events.length, 1);
    assert.ok(body.events[0].client_event_id, 'POST body event must carry client_event_id');
    assert.match(body.events[0].client_event_id, UUID_V4);
  });

  it('JSONL entry id and POST body id must match (the same entry object is reused)', async () => {
    const { logEvent } = await freshLogModule();
    logEvent('iron_rule_compliance', { action: 'violate', rule_code: 'IR-036' });
    await waitForPosts(1);

    // Align with logEvent's local-time date (IR-032 timezone policy: avoid the
    // 8h gap between UTC and Taipei making the test pick the wrong filename across midnight).
    const today = localDateOnly(new Date());
    const file = path.join(logsDir, `${today}.jsonl`);
    const localEntry = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n')[0]);
    const postedEvent = captured[0]?.events?.[0];

    assert.ok(localEntry.client_event_id);
    assert.ok(postedEvent?.client_event_id);
    assert.equal(localEntry.client_event_id, postedEvent.client_event_id,
      'local JSONL and POST body must share the same id (otherwise dedup is meaningless)');
  });
});
