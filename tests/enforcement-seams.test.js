import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLLMSwitch } from '../src/lib/llm-narrative.js';
import { startStubLlm } from './helpers/stub-llm.js';

/**
 * The seams this feature crosses, each asserted against its real counterpart.
 *
 * Every defect found while planning the standard-enforcement work had one shape: a test
 * that stubbed both sides of a boundary, so the two stubs agreed with each other and
 * neither agreed with the code. The judge was written against a guess at what
 * `callLLMSwitch` returns; the route's tests injected a stub that returned that guess; the
 * guess was wrong, and nothing anywhere could have said so.
 *
 * These tests exist to pin the assumptions the rest of the feature is built on. If one of
 * them ever goes red, the code built on top of it is wrong, not the test.
 */

test('callLLMSwitch resolves to a parsed object, not the raw string', async () => {
  const stub = await startStubLlm(JSON.stringify({
    verdicts: [{ ruleId: 412, violated: false, evidence: '', fix: '' }],
  }));
  try {
    const result = await callLLMSwitch({
      apiKey: 'stub', apiBase: stub.base,
      messages: [{ role: 'user', content: 'judge this' }],
      retries: 0, timeoutMs: 5000, overallTimeoutMs: 5000,
    });
    assert.equal(typeof result, 'object', 'a string here would mean the judge must parse it');
    assert.ok(Array.isArray(result.verdicts));
    assert.equal(result.content, undefined,
      'there is no .content wrapper; reading one yields undefined and then an empty check');
  } finally {
    stub.close();
  }
});

test('prose from the model rejects rather than arriving as text', async () => {
  // This is what makes "the judge could not answer" distinguishable from "the judge found
  // nothing" - the caller's catch turns it into a recorded failure instead of a clean pass.
  const stub = await startStubLlm('I think it is fine');
  try {
    await assert.rejects(
      () => callLLMSwitch({
        apiKey: 'stub', apiBase: stub.base,
        messages: [{ role: 'user', content: 'judge this' }],
        retries: 0, timeoutMs: 5000, overallTimeoutMs: 5000,
      }),
      /parse failed/i,
    );
  } finally {
    stub.close();
  }
});

test('the request body carries the JSON-object response format and an output budget', async () => {
  const stub = await startStubLlm(() => JSON.stringify({ verdicts: [] }));
  try {
    await callLLMSwitch({
      apiKey: 'stub', apiBase: stub.base,
      messages: [{ role: 'system', content: 'you audit' }, { role: 'user', content: 'reply' }],
      retries: 0, timeoutMs: 5000, overallTimeoutMs: 5000,
    });
    const sent = stub.requests.at(-1);
    assert.equal(sent.response_format?.type, 'json_object',
      'the judge relies on the model being held to JSON');
    assert.ok(sent.max_tokens >= 1000,
      'a verdict list has to fit in the output budget or it truncates into a parse failure');
    assert.equal(sent.messages.length, 2, 'both messages must reach the model');
  } finally {
    stub.close();
  }
});

test('retries: 0 means exactly one upstream call', async () => {
  // The judge sits on the critical path of an AI turn; a retry doubles a delay the user
  // feels. `attempts = max(1, retries + 1)`, so 0 must mean one call and not zero.
  const stub = await startStubLlm(() => JSON.stringify({ verdicts: [] }));
  try {
    await callLLMSwitch({
      apiKey: 'stub', apiBase: stub.base,
      messages: [{ role: 'user', content: 'x' }],
      retries: 0, timeoutMs: 5000, overallTimeoutMs: 5000,
    });
    assert.equal(stub.requests.length, 1);
  } finally {
    stub.close();
  }
});
