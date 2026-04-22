import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const {
  createCodexAdapter, buildEventFromTokenCount, extractSessionId
} = await import('../shared/scanners/codex.js');
const { canonicalizeCodexMaterial, codexMessageId } =
  await import('../shared/scanners/id-helper.js');

const TMP_DIR = path.join(os.tmpdir(), `ownmind-codex-test-${process.pid}-${Date.now()}`);
const FIXTURE_DIR = path.join(TMP_DIR, 'sessions');

beforeEach(async () => { await fs.mkdir(FIXTURE_DIR, { recursive: true }); });
afterEach(async () => { try { await fs.rm(TMP_DIR, { recursive: true, force: true }); } catch {} });

// ────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────

const SESSION_UUID = '019cb31a-d137-74a1-bbd8-8cfb77b7b1d1';

function tokenCountLine({ ts, totalTokens, lastInput, lastCached, lastOutput, lastReasoning }) {
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: totalTokens, input_tokens: 0, output_tokens: 0,
          cached_input_tokens: 0, reasoning_output_tokens: 0 },
        last_token_usage: {
          input_tokens: lastInput, cached_input_tokens: lastCached,
          output_tokens: lastOutput, reasoning_output_tokens: lastReasoning,
          total_tokens: lastInput + lastOutput
        }
      }
    }
  });
}

function turnContextLine(model = 'gpt-5.3-codex') {
  return JSON.stringify({
    timestamp: '2026-03-03T09:00:00.000Z',
    type: 'turn_context',
    payload: { model }
  });
}

async function writeFixture(dayPath, uuid, lines) {
  const dir = path.join(FIXTURE_DIR, dayPath);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-03-03T09-00-00-${uuid}.jsonl`);
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

// ────────────────────────────────────────────────────────────
// extractSessionId — pure
// ────────────────────────────────────────────────────────────

describe('extractSessionId', () => {
  it('extracts UUID from filename', () => {
    assert.equal(
      extractSessionId('/a/b/rollout-2026-03-03T09-00-00-019cb31a-d137-74a1-bbd8-8cfb77b7b1d1.jsonl'),
      '019cb31a-d137-74a1-bbd8-8cfb77b7b1d1'
    );
  });
  it('returns null on non-matching filename', () => {
    assert.equal(extractSessionId('/a/b/weird.jsonl'), null);
  });
});

// ────────────────────────────────────────────────────────────
// buildEventFromTokenCount — pure
// ────────────────────────────────────────────────────────────

describe('buildEventFromTokenCount', () => {
  const baseArgs = { sessionId: SESSION_UUID, model: 'gpt-5.3-codex', sourceFile: '/x.jsonl' };

  it('converts token_count with last_token_usage to event with canonical material', () => {
    const obj = JSON.parse(tokenCountLine({
      ts: '2026-03-03T09:50:34.544Z', totalTokens: 11663,
      lastInput: 11459, lastCached: 3456, lastOutput: 204, lastReasoning: 133
    }));
    const e = buildEventFromTokenCount(obj, baseArgs);
    assert.equal(e.tool, 'codex');
    assert.equal(e.session_id, SESSION_UUID);
    assert.equal(e.model, 'gpt-5.3-codex');
    // pure input = 11459 - 3456 = 8003
    assert.equal(e.input_tokens, 8003);
    assert.equal(e.output_tokens, 204);
    assert.equal(e.cache_creation_tokens, 0);
    assert.equal(e.cache_read_tokens, 3456);
    assert.equal(e.reasoning_tokens, 133);
    assert.equal(e.cumulative_total_tokens, 11663);
    // fingerprint material 完整 8 key
    for (const k of ['ts_iso', 'total_cumulative', 'last_total', 'input',
                     'output', 'cache_creation', 'cache_read', 'reasoning']) {
      assert.ok(Object.prototype.hasOwnProperty.call(e.codex_fingerprint_material, k));
    }
    // message_id 必為 64-hex sha256
    assert.match(e.message_id, /^[a-f0-9]{64}$/);
    // 同一 material 再跑一次 → 同 message_id
    const e2 = buildEventFromTokenCount(obj, baseArgs);
    assert.equal(e2.message_id, e.message_id);
  });

  it('returns null for null info (rate_limits-only token_count)', () => {
    const obj = JSON.parse(JSON.stringify({
      timestamp: 't', type: 'event_msg',
      payload: { type: 'token_count', info: null }
    }));
    assert.equal(buildEventFromTokenCount(obj, baseArgs), null);
  });

  it('returns null for non-token_count event', () => {
    assert.equal(buildEventFromTokenCount({ type: 'turn_context' }, baseArgs), null);
    assert.equal(buildEventFromTokenCount({ type: 'event_msg', payload: { type: 'other' } }, baseArgs), null);
  });

  it('returns null when last_token_usage missing', () => {
    const obj = {
      timestamp: '2026-03-03T09:00:00Z', type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 100 } } }
    };
    assert.equal(buildEventFromTokenCount(obj, baseArgs), null);
  });

  it('different last_token_usage (same ts) → different message_id (no collision)', () => {
    const common = { ts: '2026-03-03T09:00:00.000Z', totalTokens: 100,
      lastCached: 0, lastReasoning: 0 };
    const a = JSON.parse(tokenCountLine({ ...common, lastInput: 10, lastOutput: 0 }));
    const b = JSON.parse(tokenCountLine({ ...common, lastInput: 20, lastOutput: 0 }));
    const ea = buildEventFromTokenCount(a, baseArgs);
    const eb = buildEventFromTokenCount(b, baseArgs);
    assert.notEqual(ea.message_id, eb.message_id);
  });

  it('cache_creation always 0 (Codex has no cache_creation concept)', () => {
    const obj = JSON.parse(tokenCountLine({
      ts: '2026-03-03T09:00:00Z', totalTokens: 10,
      lastInput: 10, lastCached: 3, lastOutput: 0, lastReasoning: 0
    }));
    const e = buildEventFromTokenCount(obj, baseArgs);
    assert.equal(e.cache_creation_tokens, 0);
    assert.equal(e.codex_fingerprint_material.cache_creation, 0);
  });
});

// ────────────────────────────────────────────────────────────
// Adapter.readSince — integration
// ────────────────────────────────────────────────────────────

describe('createCodexAdapter.readSince', () => {
  it('parses fixture JSONL into events (turn_context updates model, token_count produces event)', async () => {
    await writeFixture('2026/03/03', SESSION_UUID, [
      turnContextLine('gpt-5.3-codex'),
      tokenCountLine({ ts: '2026-03-03T09:00:01.000Z', totalTokens: 100,
        lastInput: 50, lastCached: 10, lastOutput: 50, lastReasoning: 0 }),
      tokenCountLine({ ts: '2026-03-03T09:00:02.000Z', totalTokens: 200,
        lastInput: 50, lastCached: 10, lastOutput: 50, lastReasoning: 0 })
    ]);
    const adapter = createCodexAdapter({ baseDirs: [FIXTURE_DIR], scannerVersion: 't', machine: 'h' });
    const r = await adapter.readSince({});
    assert.equal(r.events.length, 2);
    assert.equal(r.events[0].model, 'gpt-5.3-codex');
    assert.equal(r.events[0].cumulative_total_tokens, 100);
    assert.equal(r.events[1].cumulative_total_tokens, 200);
    // 每個 event 都有 material 和 message_id
    for (const e of r.events) {
      assert.ok(e.codex_fingerprint_material);
      assert.match(e.message_id, /^[a-f0-9]{64}$/);
    }
  });

  it('byte_offset cursor — second scan with saved offset reads only new events', async () => {
    const file = await writeFixture('2026/03/03', SESSION_UUID, [
      tokenCountLine({ ts: '2026-03-03T09:00:01.000Z', totalTokens: 100,
        lastInput: 50, lastCached: 0, lastOutput: 50, lastReasoning: 0 })
    ]);
    const adapter = createCodexAdapter({ baseDirs: [FIXTURE_DIR] });
    const first = await adapter.readSince({});
    assert.equal(first.events.length, 1);

    // Simulate persisted state
    const state = { ...first.offsetPatch };

    // Append a new event
    await fs.appendFile(file, tokenCountLine({
      ts: '2026-03-03T09:00:05.000Z', totalTokens: 200,
      lastInput: 100, lastCached: 0, lastOutput: 0, lastReasoning: 0
    }) + '\n');

    const second = await adapter.readSince(state);
    assert.equal(second.events.length, 1, '只讀增量那一筆');
    assert.equal(second.events[0].cumulative_total_tokens, 200);
  });

  it('replay safety — deleting state re-scans same file → deterministic message_ids', async () => {
    await writeFixture('2026/03/03', SESSION_UUID, [
      turnContextLine(),
      tokenCountLine({ ts: '2026-03-03T09:00:01.000Z', totalTokens: 100,
        lastInput: 50, lastCached: 5, lastOutput: 50, lastReasoning: 0 })
    ]);
    const adapter = createCodexAdapter({ baseDirs: [FIXTURE_DIR] });
    const a = await adapter.readSince({});
    const b = await adapter.readSince({});
    assert.deepEqual(a.events.map((e) => e.message_id),
                     b.events.map((e) => e.message_id),
      '同一 material 不管讀幾次，message_id 應相同（server UNIQUE 會 dedupe）');
  });

  it('file compact simulation — same event at different byte offset, same message_id', async () => {
    // Codex scanner 禁止用 line_offset，但允許 byte_offset 重置。
    // 此 test 驗證：同一 ts + material 的 event 無論出現在 file 哪個位置，
    // message_id 都相同（由 canonical material 算，與 offset 無關）。
    const ts = '2026-03-03T09:00:01.000Z';
    const material = canonicalizeCodexMaterial({
      ts_iso: ts, total_cumulative: 100, last_total: 100,
      input: 50, output: 50, cache_creation: 0, cache_read: 0, reasoning: 0
    });
    const expectedId = codexMessageId(SESSION_UUID, material);

    await writeFixture('2026/03/03', SESSION_UUID, [
      turnContextLine(),
      tokenCountLine({ ts, totalTokens: 100, lastInput: 50, lastCached: 0,
        lastOutput: 50, lastReasoning: 0 })
    ]);
    const adapter = createCodexAdapter({ baseDirs: [FIXTURE_DIR] });
    const r = await adapter.readSince({});
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].message_id, expectedId,
      'message_id 完全由 material 決定，與 line 位置無關');
  });

  it('skips lines with null info (rate_limits-only token_count)', async () => {
    await writeFixture('2026/03/03', SESSION_UUID, [
      JSON.stringify({
        timestamp: '2026-03-03T09:00:00Z', type: 'event_msg',
        payload: { type: 'token_count', info: null, rate_limits: {} }
      }),
      tokenCountLine({ ts: '2026-03-03T09:00:01Z', totalTokens: 50,
        lastInput: 25, lastCached: 0, lastOutput: 25, lastReasoning: 0 })
    ]);
    const adapter = createCodexAdapter({ baseDirs: [FIXTURE_DIR] });
    const r = await adapter.readSince({});
    assert.equal(r.events.length, 1);
  });

  it('ignores malformed JSON lines without aborting', async () => {
    const file = path.join(FIXTURE_DIR, '2026/03/03', `rollout-2026-03-03T09-00-00-${SESSION_UUID}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file,
      tokenCountLine({ ts: '2026-03-03T09:00:00Z', totalTokens: 10,
        lastInput: 5, lastCached: 0, lastOutput: 5, lastReasoning: 0 }) + '\n' +
      'not valid json\n' +
      tokenCountLine({ ts: '2026-03-03T09:00:01Z', totalTokens: 20,
        lastInput: 5, lastCached: 0, lastOutput: 5, lastReasoning: 0 }) + '\n',
      'utf8');
    const adapter = createCodexAdapter({ baseDirs: [FIXTURE_DIR] });
    const r = await adapter.readSince({});
    assert.equal(r.events.length, 2);
  });

  it('handles multiple day subdirs + archived_sessions', async () => {
    await writeFixture('2026/03/03', SESSION_UUID, [
      tokenCountLine({ ts: '2026-03-03T09:00:00Z', totalTokens: 10,
        lastInput: 5, lastCached: 0, lastOutput: 5, lastReasoning: 0 })
    ]);
    await writeFixture('2026/03/04', SESSION_UUID.replace('019cb31a', '019cb31b'), [
      tokenCountLine({ ts: '2026-03-04T09:00:00Z', totalTokens: 20,
        lastInput: 10, lastCached: 0, lastOutput: 10, lastReasoning: 0 })
    ]);
    const archived = path.join(TMP_DIR, 'archived_sessions');
    const adapter = createCodexAdapter({ baseDirs: [FIXTURE_DIR, archived] });
    const r = await adapter.readSince({});
    assert.equal(r.events.length, 2);
    // 不在 fixture 的 archived dir 也不 throw
  });

  it('empty baseDir → empty events', async () => {
    const empty = path.join(TMP_DIR, 'does-not-exist');
    const adapter = createCodexAdapter({ baseDirs: [empty] });
    const r = await adapter.readSince({});
    assert.deepEqual(r.events, []);
  });

  it('turn_context-only scan still persists model into offsetPatch', async () => {
    const file = await writeFixture('2026/03/03', SESSION_UUID, [turnContextLine('custom-model-x')]);
    const adapter = createCodexAdapter({ baseDirs: [FIXTURE_DIR] });
    const r = await adapter.readSince({});
    assert.equal(r.events.length, 0, 'turn_context 不是 event，不該產 event');
    // offsetPatch 要記 model（給下一次 scan 接續）
    const key = Object.keys(r.offsetPatch)[0];
    assert.ok(key, '檔案若有任何變動（byte_offset 前進）應寫 patch');
    assert.equal(r.offsetPatch[key].model, 'custom-model-x',
      'turn_context 觀察到的 model 必須存進 offsetPatch，resume 才能接續');
  });

  it('resume scan reads persisted model from state (no turn_context in incremental read)', async () => {
    // Step 1：寫 turn_context + 1 筆 token_count
    const file = await writeFixture('2026/03/03', SESSION_UUID, [
      turnContextLine('model-A'),
      tokenCountLine({ ts: '2026-03-03T09:00:00Z', totalTokens: 10,
        lastInput: 5, lastCached: 0, lastOutput: 5, lastReasoning: 0 })
    ]);
    const adapter = createCodexAdapter({ baseDirs: [FIXTURE_DIR] });
    const r1 = await adapter.readSince({});
    assert.equal(r1.events[0].model, 'model-A');

    // Step 2：append 一筆新的 token_count（無新 turn_context）
    await fs.appendFile(file, tokenCountLine({
      ts: '2026-03-03T09:00:05Z', totalTokens: 20,
      lastInput: 5, lastCached: 0, lastOutput: 5, lastReasoning: 0
    }) + '\n');

    const state = { ...r1.offsetPatch };
    const r2 = await adapter.readSince(state);
    assert.equal(r2.events.length, 1);
    assert.equal(r2.events[0].model, 'model-A',
      '第二次 scan 沒讀到 turn_context 也要把 model 補上（從 state 接續）');
  });
});
