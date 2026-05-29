import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { logMcpCallSafe } = await import('../mcp/lib/log-mcp-call.js');

describe('logMcpCallSafe', () => {
  it('on success calls logEvent once; payload includes tool / latency_ms / status', () => {
    const calls = [];
    const fakeLog = (event, details) => calls.push({ event, details });
    logMcpCallSafe({ logEvent: fakeLog, tool: 'ownmind_save', latencyMs: 123, status: 'ok' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      event: 'mcp_call',
      details: { tool: 'ownmind_save', latency_ms: 123, status: 'ok' },
    });
  });

  it('writes status "error" when the status is error', () => {
    const calls = [];
    const fakeLog = (event, details) => calls.push({ event, details });
    logMcpCallSafe({ logEvent: fakeLog, tool: 'ownmind_get', latencyMs: 5000, status: 'error' });
    assert.equal(calls[0].details.status, 'error');
  });

  it('uses "unknown" when tool is null/undefined', () => {
    const calls = [];
    const fakeLog = (event, details) => calls.push({ event, details });
    logMcpCallSafe({ logEvent: fakeLog, tool: null, latencyMs: 50, status: 'ok' });
    assert.equal(calls[0].details.tool, 'unknown');

    calls.length = 0;
    logMcpCallSafe({ logEvent: fakeLog, tool: undefined, latencyMs: 50, status: 'ok' });
    assert.equal(calls[0].details.tool, 'unknown');
  });

  it('does not escalate when logEvent throws (the key invariant)', () => {
    const throwingLog = () => { throw new Error('disk full'); };
    assert.doesNotThrow(() => {
      logMcpCallSafe({ logEvent: throwingLog, tool: 'ownmind_save', latencyMs: 100, status: 'ok' });
    });
  });

  it('does not escalate even when logEvent throws a non-Error object', () => {
    const throwingLog = () => { throw 'string error'; };
    assert.doesNotThrow(() => {
      logMcpCallSafe({ logEvent: throwingLog, tool: 'ownmind_save', latencyMs: 100, status: 'ok' });
    });
  });

  it('writes latency_ms even when it is 0 (no filtering, avoid losing measurements)', () => {
    const calls = [];
    const fakeLog = (event, details) => calls.push({ event, details });
    logMcpCallSafe({ logEvent: fakeLog, tool: 'ownmind_init', latencyMs: 0, status: 'ok' });
    assert.equal(calls[0].details.latency_ms, 0);
  });
});
