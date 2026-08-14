import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

/**
 * v1.30.2 — the four ways a check can fail are not one thing.
 *
 * Every failure used to arrive as the same shapeless 'failed', so the notice above could only
 * say "could not reach the server". A key the server no longer accepts is not an outage: it
 * never recovers, it needs the user to sign in again, and until this classification existed
 * there was nothing in the result that could tell the two apart.
 */
test('a rejected key is a different failure from an outage', async () => {
  const stateDir = tempDir('om-compliance-');
  const rejected = await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.equal(rejected.failure, 'unauthorized');

  const broken = await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir: tempDir('om-compliance-'),
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
  });
  assert.equal(broken.failure, 'server', 'a bad gateway is the server having a moment, not a bad key');
});

test('403 is not treated as a rejected key, because this server never sends one', async () => {
  // src/middleware/auth.js answers 401 for a missing or unknown key; every 403 in the server
  // sits behind the admin routes, which this endpoint is not. So a 403 here came from
  // something in front — a proxy, a WAF, a captive portal — and 'unauthorized' is the one
  // notice in the set that gives the user an order. Ordering somebody to sign in again over a
  // corporate proxy is worse than telling them the server could not be reached, which is true.
  const result = await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir: tempDir('om-compliance-'),
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  });
  assert.equal(result.failure, 'server');
});

test('the server declining at HTTP 200 is classified, and keeps the id of its own record', async () => {
  // src/routes/compliance.js answers 200 with outcome:'failed' for four of its own failures —
  // the mode lookup, the rule fetch, the judge call and parsing the judge's answer. That is
  // the likeliest failure in production and it used to arrive with no classification at all,
  // landing in the diagnosis log as "unknown/unknown". Three of the four carry a check_id, and
  // the server row behind it holds the actual cause.
  const result = await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir: tempDir('om-compliance-'),
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ enabled: true, outcome: 'failed', violations: [], check_id: 77 }),
    }),
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failure, 'server-declined');
  assert.equal(result.check_id, 77);
  assert.match(result.reason, /server answered failed/);
});

test('the one server failure that carries no id is still told apart from the others', async () => {
  // The mode-lookup failure (src/routes/compliance.js:72) is the only 200-failed path that
  // answers enabled:false and records no row, so it is also the only one with no check_id to
  // join to. That leaves the reason as the only thing distinguishing it, and 'server answered
  // failed' for all four would have made the log a constant.
  const result = await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir: tempDir('om-compliance-'),
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ enabled: false, outcome: 'failed', violations: [] }),
    }),
  });
  assert.equal(result.failure, 'server-declined');
  assert.equal(result.check_id, null);
  assert.match(result.reason, /enabled=false/);
});

test('an unreachable host and a slow one are told apart', async () => {
  const unreachable = await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir: tempDir('om-compliance-'),
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(unreachable.failure, 'network');

  const slow = await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir: tempDir('om-compliance-'),
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  });
  assert.equal(slow.failure, 'timeout');
});

test('missing credentials are their own failure, not a network problem', async () => {
  const result = await requestCheck({ apiUrl: '', apiKey: '', payload: PAYLOAD });
  assert.equal(result.failure, 'no-credentials');
});

test('the backoff remembers what failed, so every turn inside it still says why', async () => {
  // The backoff short-circuit answered 'backing off after a failure' with no classification at
  // all, so a failure was correctly identified for exactly one turn and then spent the next
  // five minutes reading as "unknown". The user sees the notice on those turns, not the first.
  const stateDir = tempDir('om-compliance-');
  const clock = () => 1_000_000;
  await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir, now: clock,
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
  });
  const second = await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir, now: clock,
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(second.outcome, 'failed');
  assert.equal(second.failure, 'server');
  assert.match(second.reason, /502/, 'the remembered reason is what a diagnosis has to read');
});

test('a rejected key is retried within a minute, not held for five', async () => {
  // This is the one notice that tells the user to go and do something. Hold it for the full
  // five minutes and they sign in again, are told again, and conclude it did not work. Retry
  // on every single turn and the cost lands on the server instead: the whole reply re-POSTed
  // to be discarded, and an auth_failed log line, once per turn with no ceiling.
  const stateDir = tempDir('om-compliance-');
  let now = 1_000_000;
  let calls = 0;
  const rejecting = async () => { calls += 1; return { ok: false, status: 401, json: async () => ({}) }; };
  const call = (fetchImpl, apiKey = 'k') => requestCheck({
    apiUrl: 'http://x', apiKey, payload: PAYLOAD, stateDir, now: () => now, fetchImpl,
  });

  await call(rejecting);
  await call(async () => { throw new Error('must not be called'); });
  assert.equal(calls, 1, 'the turn right after is still held back');

  now += 61 * 1000;
  const fixed = await call(
    async () => ({ ok: true, status: 200, json: async () => ({ outcome: 'clean', violations: [] }) }),
    'a-new-key',
  );
  assert.equal(fixed.outcome, 'clean', 'a minute later the new key is picked up');

  // And the ordinary outage backoff is still the long one, which is what pays for itself.
  const outageDir = tempDir('om-compliance-');
  let outageNow = 1_000_000;
  let outageCalls = 0;
  const down = async () => { outageCalls += 1; throw new Error('down'); };
  await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir: outageDir, now: () => outageNow, fetchImpl: down });
  outageNow += 61 * 1000;
  await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir: outageDir, now: () => outageNow, fetchImpl: down });
  assert.equal(outageCalls, 1, 'an outage is still held for the full five minutes');
});

test('a backoff state file from an older version does not lose the turn', async () => {
  // Upgrades land mid-backoff: the file on disk has until_ms and no classification.
  const stateDir = tempDir('om-compliance-');
  fs.writeFileSync(path.join(stateDir, 'compliance-backoff.json'), JSON.stringify({ until_ms: 2_000_000 }));
  const result = await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir, now: () => 1_000_000,
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failure, 'unknown');
});

test('a failure reason cannot smuggle a credential into the log that records it', async () => {
  const result = await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir: tempDir('om-compliance-'),
    fetchImpl: async () => { throw new Error('connect failed: Bearer sk-live-abcdef'); },
  });
  assert.ok(!result.reason.includes('sk-live-abcdef'), result.reason);
});

test('a surprise response body cannot write itself into the log wholesale', async () => {
  // redact() matches credential shapes, not arbitrary text. A proxy answering HTML where JSON
  // was expected puts the head of that HTML into the parser's error message, and this reason
  // is kept on disk for weeks.
  const result = await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', payload: PAYLOAD, stateDir: tempDir('om-compliance-'),
    fetchImpl: async () => { throw new Error(`x${'y'.repeat(5000)}`); },
  });
  assert.ok(result.reason.length <= 200, `reason was ${result.reason.length} characters`);
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
