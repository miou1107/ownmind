import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { logMcpCallSafe } = await import('../mcp/lib/log-mcp-call.js');

describe('logMcpCallSafe', () => {
  it('成功時呼叫 logEvent 一次、payload 含 tool / latency_ms / status', () => {
    const calls = [];
    const fakeLog = (event, details) => calls.push({ event, details });
    logMcpCallSafe({ logEvent: fakeLog, tool: 'ownmind_save', latencyMs: 123, status: 'ok' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      event: 'mcp_call',
      details: { tool: 'ownmind_save', latency_ms: 123, status: 'ok' },
    });
  });

  it('error status 時 status 寫 "error"', () => {
    const calls = [];
    const fakeLog = (event, details) => calls.push({ event, details });
    logMcpCallSafe({ logEvent: fakeLog, tool: 'ownmind_get', latencyMs: 5000, status: 'error' });
    assert.equal(calls[0].details.status, 'error');
  });

  it('tool 是 null/undefined 時用 "unknown"', () => {
    const calls = [];
    const fakeLog = (event, details) => calls.push({ event, details });
    logMcpCallSafe({ logEvent: fakeLog, tool: null, latencyMs: 50, status: 'ok' });
    assert.equal(calls[0].details.tool, 'unknown');

    calls.length = 0;
    logMcpCallSafe({ logEvent: fakeLog, tool: undefined, latencyMs: 50, status: 'ok' });
    assert.equal(calls[0].details.tool, 'unknown');
  });

  it('logEvent throw 不會 escalate（最關鍵不變式）', () => {
    const throwingLog = () => { throw new Error('disk full'); };
    assert.doesNotThrow(() => {
      logMcpCallSafe({ logEvent: throwingLog, tool: 'ownmind_save', latencyMs: 100, status: 'ok' });
    });
  });

  it('logEvent throw 非 Error 物件也不 escalate', () => {
    const throwingLog = () => { throw 'string error'; };
    assert.doesNotThrow(() => {
      logMcpCallSafe({ logEvent: throwingLog, tool: 'ownmind_save', latencyMs: 100, status: 'ok' });
    });
  });

  it('latency_ms 是 0 也照寫（不過濾、避免漏量）', () => {
    const calls = [];
    const fakeLog = (event, details) => calls.push({ event, details });
    logMcpCallSafe({ logEvent: fakeLog, tool: 'ownmind_init', latencyMs: 0, status: 'ok' });
    assert.equal(calls[0].details.latency_ms, 0);
  });
});
