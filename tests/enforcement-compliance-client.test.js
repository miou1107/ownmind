import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';
import { requestCheck, redact } from '../hooks/lib/compliance-client.js';

/**
 * The client half.
 *
 * `fetch` is injected here, which is the one stub allowed: the server it would call has its
 * own tests against a real router. What must not be faked is the shape this client produces,
 * because the step above it decides what the user sees from exactly these fields.
 */

const PAYLOAD = { session_id: 's1', assistant_text: 'hello', user_prompts: [] };

test('a violation response is passed through unchanged', async () => {
  const stateDir = tempDir('om-compliance-');
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      enabled: true,
      outcome: 'violation',
      violations: [{ ruleId: 412, ruleTitle: 'ci ownership', evidence: 'e', fix: 'f' }],
      check_id: 9,
    }),
  });
  const result = await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, fetchImpl, stateDir });
  assert.equal(result.outcome, 'violation');
  assert.equal(result.violations.length, 1);
  assert.equal(result.check_id, 9);
});

test('a network failure is failed, never clean', async () => {
  const stateDir = tempDir('om-compliance-');
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const result = await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, fetchImpl, stateDir });
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.violations, []);
});

test('an HTTP error is failed, and says which one', async () => {
  const stateDir = tempDir('om-compliance-');
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const result = await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, fetchImpl, stateDir });
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason, /401/);
});

test('after a failure the next turn backs off instead of paying the timeout again', async () => {
  // An unreachable server would otherwise cost every single reply a full timeout for the
  // length of the outage, and the user would feel it without being told why.
  const stateDir = tempDir('om-compliance-');
  let calls = 0;
  const failing = async () => { calls += 1; throw new Error('down'); };
  const clock = () => 1_000_000;
  await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, fetchImpl: failing, stateDir, now: clock });
  await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, fetchImpl: failing, stateDir, now: clock });
  assert.equal(calls, 1, 'the second call inside the backoff window must not hit the network');
});

test('the backoff expires', async () => {
  const stateDir = tempDir('om-compliance-');
  let calls = 0;
  let now = 1_000_000;
  const failing = async () => { calls += 1; throw new Error('down'); };
  await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, fetchImpl: failing, stateDir, now: () => now });
  now += 10 * 60 * 1000;
  await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, fetchImpl: failing, stateDir, now: () => now });
  assert.equal(calls, 2);
});

test('the auth header is the scheme the server actually accepts', async () => {
  // src/middleware/auth.js rejects anything that does not start with "Bearer ". An x-api-key
  // header would 401 every check, and this client would record that as a server problem.
  const stateDir = tempDir('om-compliance-');
  let headers = null;
  const fetchImpl = async (_url, opts) => {
    headers = opts.headers;
    return { ok: true, json: async () => ({ outcome: 'clean', violations: [] }) };
  };
  await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, fetchImpl, stateDir });
  assert.match(headers.Authorization, /^Bearer /);
});

test('credential-shaped text is redacted before it leaves the machine', async () => {
  const stateDir = tempDir('om-compliance-');
  let sent = null;
  const fetchImpl = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ outcome: 'clean', violations: [] }) };
  };
  await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', fetchImpl, stateDir,
    payload: {
      session_id: 's1',
      assistant_text: 'run it with api_key=sk-live-abcdef and Bearer tok_9999',
      user_prompts: ['my password: hunter2'],
    },
  });
  assert.ok(!sent.assistant_text.includes('sk-live-abcdef'));
  assert.ok(!sent.assistant_text.includes('tok_9999'));
  assert.ok(!sent.user_prompts[0].includes('hunter2'));
});

test('redaction leaves ordinary text alone', () => {
  const text = 'I will edit ci/projects.yml because you are an admin';
  assert.equal(redact(text), text);
});

test('missing credentials fail rather than throw', async () => {
  const result = await requestCheck({ apiUrl: '', apiKey: '', payload: PAYLOAD });
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason, /credentials/);
});

test('the endpoint asked for is the compliance check', async () => {
  const stateDir = tempDir('om-compliance-');
  let url = null;
  const fetchImpl = async (u) => {
    url = u;
    return { ok: true, json: async () => ({ outcome: 'clean', violations: [] }) };
  };
  await requestCheck({ apiUrl: 'http://x/', apiKey: 'k', payload: PAYLOAD, fetchImpl, stateDir });
  assert.equal(url, 'http://x/api/compliance/check', 'a trailing slash must not double up');
});

// v1.26.171 — the one changed line in this module. The step tests inject their own
// requestCheckImpl, so without this seam test both ends of the `enabled` contract would be
// fakes agreeing with each other.
test('a server body carrying enabled:false survives into the result', async () => {
  const stateDir = tempDir('om-compliance-');
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ outcome: 'skipped', enabled: false, violations: [] }),
  });
  const result = await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, fetchImpl, stateDir });
  assert.equal(result.outcome, 'skipped');
  assert.equal(result.enabled, false);
});

test('a server that never sends enabled reads as enabled', async () => {
  // Older servers predate the field. Mapping absence to false would make every legacy
  // skipped response loudly claim enforcement is switched off.
  const stateDir = tempDir('om-compliance-');
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ outcome: 'skipped', violations: [] }),
  });
  const result = await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, fetchImpl, stateDir });
  assert.equal(result.enabled, true);
});
