import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const {
  readOffsets, writeOffsetsAtomic, chunk, mergeState, runScan, postBatch, BATCH_SIZE
} = await import('../shared/scanners/base.js');

const TMP_DIR = path.join(os.tmpdir(), `ownmind-scanner-test-${process.pid}-${Date.now()}`);
const CACHE_PATH = path.join(TMP_DIR, 'offsets.json');

beforeEach(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
  try { await fs.unlink(CACHE_PATH); } catch { /* ignore */ }
});

afterEach(async () => {
  try { await fs.rm(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ────────────────────────────────────────────────────────────
// pure helpers
// ────────────────────────────────────────────────────────────

describe('chunk', () => {
  it('splits array into fixed-size batches', () => {
    const arr = Array.from({ length: 12 }, (_, i) => i);
    assert.deepEqual(chunk(arr, 5), [[0,1,2,3,4],[5,6,7,8,9],[10,11]]);
  });
  it('empty input → empty output', () => {
    assert.deepEqual(chunk([], 100), []);
  });
  it('default size is BATCH_SIZE', () => {
    assert.equal(BATCH_SIZE, 500);
    const arr = new Array(501).fill(0);
    assert.equal(chunk(arr).length, 2);
  });
});

describe('mergeState', () => {
  it('merges offset patch + session cumulative patch immutably', () => {
    const state = {
      'claude-code:/a.jsonl': { byte_offset: 10 },
      session_cumulative: { 'claude-code': { s1: 100, s2: 50 } }
    };
    const next = mergeState(state, 'claude-code',
      { 'claude-code:/a.jsonl': { byte_offset: 20 } },
      { s1: 150, s3: 5 });
    assert.equal(next['claude-code:/a.jsonl'].byte_offset, 20);
    assert.equal(next.session_cumulative['claude-code'].s1, 150);
    assert.equal(next.session_cumulative['claude-code'].s2, 50, 's2 未變');
    assert.equal(next.session_cumulative['claude-code'].s3, 5, '新 session');
    // 原 state 不應被改
    assert.equal(state['claude-code:/a.jsonl'].byte_offset, 10);
  });

  it('works when state lacks session_cumulative', () => {
    const next = mergeState({}, 'claude-code', {}, { s1: 1 });
    assert.equal(next.session_cumulative['claude-code'].s1, 1);
  });
});

// ────────────────────────────────────────────────────────────
// offset persistence
// ────────────────────────────────────────────────────────────

describe('readOffsets / writeOffsetsAtomic', () => {
  it('returns {} when file missing', async () => {
    const s = await readOffsets(CACHE_PATH);
    assert.deepEqual(s, {});
  });

  it('returns {} when file corrupt', async () => {
    await fs.writeFile(CACHE_PATH, 'not json');
    const s = await readOffsets(CACHE_PATH);
    assert.deepEqual(s, {});
  });

  it('atomic write then read roundtrip', async () => {
    const data = { a: 1, nested: { b: 2 } };
    await writeOffsetsAtomic(CACHE_PATH, data);
    const roundtrip = await readOffsets(CACHE_PATH);
    assert.deepEqual(roundtrip, data);
  });

  it('writes to .tmp then renames (no half-written state visible)', async () => {
    // 寫一個初始值
    await writeOffsetsAtomic(CACHE_PATH, { v: 1 });
    // 再寫第二次
    await writeOffsetsAtomic(CACHE_PATH, { v: 2 });
    const entries = await fs.readdir(TMP_DIR);
    // 不應留下任何 .tmp
    assert.ok(!entries.some((e) => e.endsWith('.tmp')), '不應有 .tmp 殘留');
    assert.deepEqual(await readOffsets(CACHE_PATH), { v: 2 });
  });
});

// ────────────────────────────────────────────────────────────
// runScan integration w/ fake adapter + fake fetch
// ────────────────────────────────────────────────────────────

function makeFakeAdapter(events, heartbeat = null,
                        offsetPatch = {}, cumulativePatch = {}) {
  return {
    tool: 'claude-code',
    async readSince() {
      return { events, offsetPatch, cumulativePatch, heartbeat };
    }
  };
}

function makeFakeFetch(responses) {
  const calls = [];
  let i = 0;
  const fetchFn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    const r = responses[i++] ?? { ok: true, json: { accepted: 0, duplicated: 0 } };
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      async json() { return r.json; },
      async text() { return r.text || ''; }
    };
  };
  return { fetchFn, calls };
}

describe('runScan', () => {
  it('sends 1 batch for small event list, persists offsets on success', async () => {
    const adapter = makeFakeAdapter(
      [{ tool: 'claude-code', session_id: 's1', message_id: 'm1' }],
      { tool: 'claude-code', scanner_version: '1.16.0', machine: 'host1' },
      { 'claude-code:/a.jsonl': { byte_offset: 100, last_scan: '2026-04-21T00:00:00Z' } },
      { s1: 100 }
    );
    const { fetchFn, calls } = makeFakeFetch([
      { ok: true, json: { accepted: 1, duplicated: 0 } }
    ]);

    const result = await runScan({
      adapter, apiUrl: 'http://test/', apiKey: 'xx',
      cachePath: CACHE_PATH, fetchFn, logger: { info: () => {} }
    });

    assert.equal(result.sent, 1);
    assert.equal(result.batches, 1);
    assert.equal(result.accepted, 1);
    assert.equal(calls.length, 1);
    // heartbeat attached to last (only) batch
    assert.ok(calls[0].body.heartbeat);
    assert.equal(calls[0].body.heartbeat.tool, 'claude-code');
    // offsets persisted
    const saved = await readOffsets(CACHE_PATH);
    assert.equal(saved['claude-code:/a.jsonl'].byte_offset, 100);
    assert.equal(saved.session_cumulative['claude-code'].s1, 100);
  });

  it('splits >500 events into multiple batches; heartbeat on last only', async () => {
    const events = Array.from({ length: 1200 }, (_, i) => ({
      tool: 'claude-code', session_id: 's1', message_id: `m${i}`
    }));
    const adapter = makeFakeAdapter(
      events,
      { tool: 'claude-code', scanner_version: 'v', machine: 'h' },
      {}, {}
    );
    const { fetchFn, calls } = makeFakeFetch([
      { ok: true, json: { accepted: 500 } },
      { ok: true, json: { accepted: 500 } },
      { ok: true, json: { accepted: 200 } }
    ]);
    const r = await runScan({
      adapter, apiUrl: 'http://test', apiKey: 'x',
      cachePath: CACHE_PATH, fetchFn, logger: { info: () => {} }
    });
    assert.equal(r.batches, 3);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].body.events.length, 500);
    assert.equal(calls[1].body.events.length, 500);
    assert.equal(calls[2].body.events.length, 200);
    // heartbeat only on final batch
    assert.equal(calls[0].body.heartbeat, undefined);
    assert.equal(calls[1].body.heartbeat, undefined);
    assert.ok(calls[2].body.heartbeat);
  });

  it('batch failure aborts → offset NOT persisted → retry sends everything again', async () => {
    const events = Array.from({ length: 3 }, (_, i) => ({
      tool: 'claude-code', session_id: 's1', message_id: `m${i}`
    }));
    const adapter = makeFakeAdapter(events, null,
      { 'claude-code:/a.jsonl': { byte_offset: 99 } },
      { s1: 3 });
    const { fetchFn } = makeFakeFetch([
      { ok: false, status: 500, text: 'server error' }
    ]);

    await assert.rejects(
      () => runScan({ adapter, apiUrl: 'http://test', apiKey: 'x',
        cachePath: CACHE_PATH, fetchFn, logger: { info: () => {} } }),
      /500/
    );

    // Offsets should NOT be persisted
    const s = await readOffsets(CACHE_PATH);
    assert.deepEqual(s, {}, 'failed scan must not advance offset');
  });

  it('empty events → sends heartbeat-only POST', async () => {
    const adapter = makeFakeAdapter([], { tool: 'claude-code', scanner_version: 'v', machine: 'h' });
    const { fetchFn, calls } = makeFakeFetch([{ ok: true, json: { accepted: 0, duplicated: 0 } }]);
    const r = await runScan({
      adapter, apiUrl: 'http://test', apiKey: 'x',
      cachePath: CACHE_PATH, fetchFn, logger: { info: () => {} }
    });
    assert.equal(r.sent, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.events, []);
    assert.ok(calls[0].body.heartbeat);
  });
});

describe('postBatch', () => {
  it('POSTs to /api/usage/events with Bearer auth and JSON body', async () => {
    let captured;
    const fetchFn = async (url, opts) => {
      captured = { url, opts };
      return { ok: true, async json() { return { accepted: 1 }; } };
    };
    const resp = await postBatch(
      { apiUrl: 'http://api/', apiKey: 'k', fetchFn },
      { events: [{ m: 1 }] }
    );
    assert.equal(captured.url, 'http://api/api/usage/events');
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers.authorization, 'Bearer k');
    assert.deepEqual(JSON.parse(captured.opts.body), { events: [{ m: 1 }] });
    assert.deepEqual(resp, { accepted: 1 });
  });

  it('throws on non-2xx', async () => {
    const fetchFn = async () => ({ ok: false, status: 400, async text() { return '{"error":"bad"}'; } });
    await assert.rejects(
      () => postBatch({ apiUrl: 'http://api', apiKey: 'k', fetchFn }, { events: [] }),
      /400/
    );
  });
});
