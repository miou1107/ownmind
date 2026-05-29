import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildApiErrorMessage } from '../mcp/lib/api-error-message.js';

describe('buildApiErrorMessage — surface structured API error detail to the AI/user', () => {
  test('iron_rule lint rejection: surfaces the specific errors array, not just the generic error', () => {
    // Reproduction of the reported bug: server returns error + errors[] + hint,
    // but the MCP client used to surface only `error`, hiding the actionable detail.
    const data = {
      error: 'Iron rule quality check failed — please fix the following issues and try again',
      errors: [
        'missing a trigger:xxx tag — without a trigger word the AI does not know when to recall this iron rule',
        'missing a scenario section — the content must explain when it applies',
      ],
      hint: 'An iron rule must let a future-session AI understand when it triggers and what the rule says.',
    };
    const msg = buildApiErrorMessage(data, JSON.stringify(data));

    assert.ok(msg.includes('missing a trigger:xxx tag'), 'should surface the first lint error');
    assert.ok(msg.includes('missing a scenario section'), 'should surface the second lint error');
    assert.ok(msg.includes('An iron rule must let'), 'should surface the hint');
    // The top-level error must remain (sync_token retry matching and readability depend on it).
    assert.ok(msg.includes('quality check failed'), 'should keep the top-level error');
  });

  test('plain error only (no errors array): returns the error verbatim — keeps sync_token retry matching intact', () => {
    const data = { error: 'sync_token is stale, please refresh and retry' };
    const msg = buildApiErrorMessage(data, '');
    assert.equal(msg, 'sync_token is stale, please refresh and retry');
  });

  test('uses the message field when error is absent', () => {
    const data = { message: 'something went wrong' };
    const msg = buildApiErrorMessage(data, '');
    assert.equal(msg, 'something went wrong');
  });

  test('non-object data falls back to the raw text', () => {
    const msg = buildApiErrorMessage('raw text error body', 'raw text error body');
    assert.equal(msg, 'raw text error body');
  });

  test('empty object falls back to JSON so nothing is silently dropped', () => {
    const msg = buildApiErrorMessage({}, '{}');
    assert.equal(msg, '{}');
  });

  test('ignores a non-array errors field gracefully (only the error/message surfaces)', () => {
    const data = { error: 'bad request', errors: 'not-an-array' };
    const msg = buildApiErrorMessage(data, '');
    assert.equal(msg, 'bad request');
  });
});
