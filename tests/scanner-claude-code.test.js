import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const { createClaudeCodeAdapter, parseAssistantLine, defaultReadIncremental } =
  await import('../shared/scanners/claude-code.js');

const TMP_DIR = path.join(os.tmpdir(), `ownmind-cc-test-${process.pid}-${Date.now()}`);
const FIXTURE_DIR = path.join(TMP_DIR, 'claude-projects');

beforeEach(async () => { await fs.mkdir(FIXTURE_DIR, { recursive: true }); });
afterEach(async () => { try { await fs.rm(TMP_DIR, { recursive: true, force: true }); } catch {} });

// ────────────────────────────────────────────────────────────
// parseAssistantLine — pure
// ────────────────────────────────────────────────────────────

const SAMPLE = {
  type: 'assistant',
  uuid: 'abc-123',
  timestamp: '2026-04-21T09:00:00.000Z',
  sessionId: 'sess-42',
  message: {
    model: 'claude-opus-4-7',
    usage: {
      input_tokens: 6,
      output_tokens: 1163,
      cache_creation_input_tokens: 59352,
      cache_read_input_tokens: 0
    }
  }
};

describe('parseAssistantLine', () => {
  it('parses a well-formed assistant line', () => {
    const p = parseAssistantLine(JSON.stringify(SAMPLE));
    assert.equal(p.session_id, 'sess-42');
    assert.equal(p.message_id, 'abc-123');
    assert.equal(p.model, 'claude-opus-4-7');
    assert.equal(p.ts, '2026-04-21T09:00:00.000Z');
    assert.equal(p.input_tokens, 6);
    assert.equal(p.output_tokens, 1163);
    assert.equal(p.cache_creation_tokens, 59352);
    assert.equal(p.cache_read_tokens, 0);
  });

  it('returns null for non-assistant types', () => {
    assert.equal(parseAssistantLine(JSON.stringify({ ...SAMPLE, type: 'user' })), null);
    assert.equal(parseAssistantLine(JSON.stringify({ ...SAMPLE, type: 'queue-operation' })), null);
  });

  it('returns null when message.usage missing', () => {
    const { usage: _drop, ...restMsg } = SAMPLE.message;
    void _drop;
    assert.equal(parseAssistantLine(JSON.stringify({ ...SAMPLE, message: restMsg })), null);
  });

  it('returns null for invalid JSON / empty / missing fields', () => {
    assert.equal(parseAssistantLine(''), null);
    assert.equal(parseAssistantLine('not-json'), null);
    assert.equal(parseAssistantLine(JSON.stringify({ ...SAMPLE, uuid: null })), null);
    assert.equal(parseAssistantLine(JSON.stringify({ ...SAMPLE, sessionId: null })), null);
    assert.equal(parseAssistantLine(JSON.stringify({ ...SAMPLE, timestamp: null })), null);
  });
});

// ────────────────────────────────────────────────────────────
// defaultReadIncremental — byte-offset semantics
// ────────────────────────────────────────────────────────────

describe('defaultReadIncremental', () => {
  it('returns complete lines only; partial line kept for next scan', async () => {
    const file = path.join(TMP_DIR, 'partial.jsonl');
    await fs.writeFile(file, 'line-1\nline-2\npartial-no-newline', 'utf8');
    const { lines, nextOffset } = await defaultReadIncremental(file, 0);
    assert.deepEqual(lines, ['line-1', 'line-2']);
    // nextOffset should stop before "partial-no-newline"
    assert.equal(nextOffset, 'line-1\nline-2\n'.length);

    // Append the rest, scan again from nextOffset
    await fs.appendFile(file, '\nline-3\n');
    const r2 = await defaultReadIncremental(file, nextOffset);
    assert.deepEqual(r2.lines, ['partial-no-newline', 'line-3']);
  });

  it('handles byte_offset > file size by resetting to 0 (truncate scenario)', async () => {
    const file = path.join(TMP_DIR, 'trunc.jsonl');
    await fs.writeFile(file, 'short\n', 'utf8');
    const { lines, nextOffset } = await defaultReadIncremental(file, 999_999);
    assert.deepEqual(lines, ['short']);
    assert.equal(nextOffset, 'short\n'.length);
  });

  it('empty additions return [] with same offset', async () => {
    const file = path.join(TMP_DIR, 'nothing.jsonl');
    await fs.writeFile(file, 'x\n', 'utf8');
    const firstEnd = 'x\n'.length;
    const r = await defaultReadIncremental(file, firstEnd);
    assert.deepEqual(r.lines, []);
    assert.equal(r.nextOffset, firstEnd);
  });

  it('byte offset accounting is correct for multi-byte UTF-8', async () => {
    const file = path.join(TMP_DIR, 'utf8.jsonl');
    const chinese = '繁體中文';  // 12 bytes in UTF-8
    const line = `{"msg":"${chinese}"}`;
    await fs.writeFile(file, `${line}\n`, 'utf8');
    const { nextOffset } = await defaultReadIncremental(file, 0);
    assert.equal(nextOffset, Buffer.byteLength(line + '\n', 'utf8'));
  });
});

// ────────────────────────────────────────────────────────────
// Adapter.readSince — fixture + cumulative + crash-resume + replay
// ────────────────────────────────────────────────────────────

function makeJsonl(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function assistantEvent(sessionId, messageId, usage, ts = '2026-04-21T09:00:00.000Z') {
  return {
    type: 'assistant', uuid: messageId, timestamp: ts, sessionId,
    message: { model: 'claude-opus-4-7', usage }
  };
}

async function writeFixture(project, session, events) {
  const dir = path.join(FIXTURE_DIR, project);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  await fs.writeFile(file, makeJsonl(events), 'utf8');
  return file;
}

describe('createClaudeCodeAdapter.readSince', () => {
  it('parses fixture JSONL into Tier 1 events with running cumulative', async () => {
    await writeFixture('proj-A', 'sess-1', [
      assistantEvent('sess-1', 'm1', { input_tokens: 10, output_tokens: 20,
        cache_creation_input_tokens: 100, cache_read_input_tokens: 0 }),
      { type: 'user', content: 'should be skipped' },  // non-assistant
      assistantEvent('sess-1', 'm2', { input_tokens: 5,  output_tokens: 15,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 50 })
    ]);
    const adapter = createClaudeCodeAdapter({ baseDir: FIXTURE_DIR, scannerVersion: 't', machine: 'host' });
    const { events, cumulativePatch, offsetPatch, heartbeat } = await adapter.readSince({});

    assert.equal(events.length, 2);
    // first event: cumulative = 10 + 20 + 100 + 0 = 130
    assert.equal(events[0].cumulative_total_tokens, 130);
    // second: prev 130 + 5 + 15 + 0 + 50 = 200
    assert.equal(events[1].cumulative_total_tokens, 200);
    assert.equal(cumulativePatch['sess-1'], 200);
    assert.equal(heartbeat.tool, 'claude-code');
    assert.equal(heartbeat.machine, 'host');
    assert.ok(Object.keys(offsetPatch).length === 1);
  });

  it('resumes cumulative from state — does NOT reset to 0 on restart', async () => {
    await writeFixture('p', 's1', [
      assistantEvent('s1', 'm1', { input_tokens: 50, output_tokens: 50,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
    ]);
    const adapter = createClaudeCodeAdapter({ baseDir: FIXTURE_DIR });
    const state = {
      session_cumulative: { 'claude-code': { 's1': 1000 } }  // 既有 running total
    };
    const { events, cumulativePatch } = await adapter.readSince(state);
    // 1000 + 50 + 50 = 1100
    assert.equal(events[0].cumulative_total_tokens, 1100);
    assert.equal(cumulativePatch.s1, 1100);
  });

  it('handles multiple sessions per scan with independent cumulative per session', async () => {
    await writeFixture('p', 'a', [
      assistantEvent('a', 'am1', { input_tokens: 10, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
    ]);
    await writeFixture('p', 'b', [
      assistantEvent('b', 'bm1', { input_tokens: 100, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
    ]);
    const adapter = createClaudeCodeAdapter({ baseDir: FIXTURE_DIR });
    const { cumulativePatch } = await adapter.readSince({});
    assert.equal(cumulativePatch.a, 10);
    assert.equal(cumulativePatch.b, 100);
  });

  it('only reads new lines — byte_offset honored → replay safety', async () => {
    const file = await writeFixture('p', 's1', [
      assistantEvent('s1', 'm1', { input_tokens: 1, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
    ]);
    const adapter = createClaudeCodeAdapter({ baseDir: FIXTURE_DIR });

    const firstScan = await adapter.readSince({});
    assert.equal(firstScan.events.length, 1);

    // Second scan with saved offset → no new events
    const mergedState = {
      ...firstScan.offsetPatch,
      session_cumulative: { 'claude-code': { s1: firstScan.cumulativePatch.s1 } }
    };
    const secondScan = await adapter.readSince(mergedState);
    assert.equal(secondScan.events.length, 0, '同一檔案第二次 scan 不應重送');

    // Append a new line → third scan picks it up, cumulative continues from 1
    await fs.appendFile(file, JSON.stringify(
      assistantEvent('s1', 'm2', { input_tokens: 9, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
    ) + '\n');
    const third = await adapter.readSince(mergedState);
    assert.equal(third.events.length, 1);
    assert.equal(third.events[0].cumulative_total_tokens, 10, '1 + 9 = 10（不是 9，也不是 19）');
  });

  it('crash-resume: if state not persisted, replay from 0 yields same final DB (via UNIQUE)', async () => {
    // 此 test 模擬「scanner 讀了 3 行、送到 server、但 offset 沒寫回」的情境：
    //   - scan 1：讀 3 行 → 所有 event 被 server 接收
    //   - scan 2：state={}（模擬 crash）→ 再讀同 3 行 → event 的 message_id 與 ts 與 scan 1 相同
    // 結論：crash resume 等於 replay；server 端 UNIQUE 擋重複；本 test 確認 adapter 端
    //      產出 deterministic（同一個檔案不論幾次從 0 scan，event list 相同）
    await writeFixture('p', 's1', [
      assistantEvent('s1', 'm1', { input_tokens: 1, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
      assistantEvent('s1', 'm2', { input_tokens: 2, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
      assistantEvent('s1', 'm3', { input_tokens: 3, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
    ]);
    const adapter = createClaudeCodeAdapter({ baseDir: FIXTURE_DIR });
    const a = await adapter.readSince({});
    const b = await adapter.readSince({});
    assert.deepEqual(a.events.map((e) => e.message_id), b.events.map((e) => e.message_id),
      'crash-resume 後同一 state 再跑 → event list 相同，server UNIQUE 做 dedupe');
    // Cumulative 也相同
    assert.deepEqual(a.events.map((e) => e.cumulative_total_tokens),
      b.events.map((e) => e.cumulative_total_tokens));
  });

  it('ignores malformed lines without aborting', async () => {
    const file = path.join(FIXTURE_DIR, 'proj', 's.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file,
      JSON.stringify(assistantEvent('s', 'm1', { input_tokens: 1, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })) + '\n' +
      'this is not json\n' +
      JSON.stringify(assistantEvent('s', 'm2', { input_tokens: 2, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })) + '\n',
      'utf8');
    const adapter = createClaudeCodeAdapter({ baseDir: FIXTURE_DIR });
    const { events } = await adapter.readSince({});
    assert.equal(events.length, 2);
    assert.equal(events[0].message_id, 'm1');
    assert.equal(events[1].message_id, 'm2');
  });

  it('empty baseDir → empty events, no crash', async () => {
    const empty = path.join(TMP_DIR, 'does-not-exist');
    const adapter = createClaudeCodeAdapter({ baseDir: empty });
    const r = await adapter.readSince({});
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.offsetPatch, {});
  });
});
