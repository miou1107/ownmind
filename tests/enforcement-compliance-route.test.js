import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createComplianceRouter } from '../src/routes/compliance.js';
import { startServer } from './helpers/app-server.js';
import { startStubLlm } from './helpers/stub-llm.js';
import { callLLMSwitch } from '../src/lib/llm-narrative.js';

/**
 * The judge endpoint.
 *
 * One end of the model seam is stubbed here - the upstream model, which nothing in this repo
 * controls. The helper that talks to it is the real one, because the first draft of this
 * route was built on a guess about what that helper returns and every test agreed with the
 * guess rather than with the code.
 */

const RULE_412 = {
  id: 412,
  type: 'team_standard',
  title: 'ci ownership',
  content: 'Only the colleague may edit ci/. No engineer including admins may.',
  tags: [],
  metadata: { enforcement: { keywords: ['FAPA'] } },
};

const PAYLOAD = {
  session_id: 's1',
  turn_index: 1,
  assistant_text: 'Stage 0: I will add an entry to ci/projects.yml. You are an admin so I have permission.',
  user_prompts: ['migrate ownmind to FAPA'],
  repo_remote: null,
};

function appWith({ mode = 'check', memories = [], llmFn, inserts = [] }) {
  const queryFn = async (sql, params) => {
    if (/FROM users/i.test(sql)) return { rows: [{ enforcement_mode: mode }] };
    if (/INSERT INTO compliance_checks/i.test(sql)) {
      inserts.push({ sql, params });
      return { rows: [{ id: 77 }] };
    }
    if (/UPDATE compliance_checks/i.test(sql)) {
      inserts.push({ sql, params });
      return { rows: [] };
    }
    if (/FROM memories/i.test(sql)) return { rows: memories };
    return { rows: [] };
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use('/api/compliance', createComplianceRouter({ queryFn, llmFn }));
  return app;
}

async function post(app, path, body) {
  const server = await startServer(app);
  try {
    const res = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    await server.close();
  }
}

test('an account with enforcement off never reaches the model', async () => {
  let called = false;
  const app = appWith({
    mode: 'off', memories: [RULE_412], llmFn: async () => { called = true; return {}; },
  });
  const { json } = await post(app, '/api/compliance/check', PAYLOAD);
  assert.equal(json.enabled, false);
  assert.equal(called, false, 'an account that is off must cost no tokens and no latency');
});

test('a violation comes back with the rule, the evidence and what to do', async () => {
  const llmFn = async () => ({
    verdicts: [{
      ruleId: 412, violated: true,
      evidence: 'I will add an entry to ci/projects.yml',
      fix: 'open an issue for the colleague',
    }],
  });
  const app = appWith({ memories: [RULE_412], llmFn });
  const { json } = await post(app, '/api/compliance/check', PAYLOAD);
  assert.equal(json.outcome, 'violation');
  assert.equal(json.violations[0].ruleTitle, 'ci ownership');
  assert.equal(json.violations[0].ruleType, 'team_standard');
  assert.match(json.violations[0].evidence, /ci\/projects\.yml/);
  assert.match(json.violations[0].fix, /issue/);
});

test('the real LLM helper is what the route drives, and its return shape works end to end', async () => {
  // The seam that broke the first draft, exercised through the real callLLMSwitch against a
  // stub upstream: had the route read `.content`, this test would fail where the others pass.
  const stub = await startStubLlm(JSON.stringify({
    verdicts: [{ ruleId: 412, violated: true, evidence: 'ci/projects.yml', fix: 'ask first' }],
  }));
  try {
    const llmFn = (messages) => callLLMSwitch({
      apiKey: 'stub', apiBase: stub.base, messages,
      retries: 0, timeoutMs: 5000, overallTimeoutMs: 5000,
    });
    const app = appWith({ memories: [RULE_412], llmFn });
    const { json } = await post(app, '/api/compliance/check', PAYLOAD);
    assert.equal(json.outcome, 'violation');
    assert.equal(json.violations[0].ruleId, 412);
  } finally {
    stub.close();
  }
});

test('a model that answers in prose is failed, not clean', async () => {
  const stub = await startStubLlm('I think that looks fine to me');
  try {
    const llmFn = (messages) => callLLMSwitch({
      apiKey: 'stub', apiBase: stub.base, messages,
      retries: 0, timeoutMs: 5000, overallTimeoutMs: 5000,
    });
    const app = appWith({ memories: [RULE_412], llmFn });
    const { json } = await post(app, '/api/compliance/check', PAYLOAD);
    assert.equal(json.outcome, 'failed', 'unreadable is not the same as nothing wrong');
  } finally {
    stub.close();
  }
});

test('a well-formed answer in the wrong shape is failed, not clean', async () => {
  // Distinct from the two cases above: the call succeeds and the JSON parses, but there is
  // no verdict list in it. Mutation testing found this path had no coverage at all - forcing
  // parseFailed to false broke nothing, which means nothing was checking it.
  const app = appWith({
    memories: [RULE_412],
    llmFn: async () => ({ answer: 'looks fine to me' }),
  });
  const { json } = await post(app, '/api/compliance/check', PAYLOAD);
  assert.equal(json.outcome, 'failed');
  assert.deepEqual(json.violations, []);
});

test('a verdict list containing nothing usable is still failed, not clean', async () => {
  const app = appWith({ memories: [RULE_412], llmFn: async () => ({ verdicts: 'not an array' }) });
  const { json } = await post(app, '/api/compliance/check', PAYLOAD);
  assert.equal(json.outcome, 'failed');
});

test('a model failure is failed, never clean', async () => {
  const app = appWith({ memories: [RULE_412], llmFn: async () => { throw new Error('upstream down'); } });
  const { json } = await post(app, '/api/compliance/check', PAYLOAD);
  assert.equal(json.outcome, 'failed');
  assert.deepEqual(json.violations, []);
});

test('nothing selected is skipped, and is still recorded', async () => {
  const inserts = [];
  const app = appWith({ memories: [], llmFn: async () => ({ verdicts: [] }), inserts });
  const { json } = await post(app, '/api/compliance/check', PAYLOAD);
  assert.equal(json.outcome, 'skipped');
  assert.equal(inserts.length, 1, 'a skipped check must leave a record, or the rate is unmeasurable');
});

test('what was looked at is recorded even when the verdict is clean', async () => {
  // "The rule was never selected" and "the rule was selected and misjudged" need different
  // fixes, and cannot be told apart afterwards without this.
  const inserts = [];
  const app = appWith({
    memories: [RULE_412], inserts,
    llmFn: async () => ({ verdicts: [{ ruleId: 412, violated: false, evidence: '', fix: '' }] }),
  });
  const { json } = await post(app, '/api/compliance/check', PAYLOAD);
  assert.equal(json.outcome, 'clean');
  assert.match(JSON.stringify(inserts[0].params), /412/);
});

test('a verdict for a rule that was not selected is ignored', async () => {
  // The judge answering about something it was not asked is a hallucinated finding, and a
  // hallucinated finding pushed back at the assistant is worse than a missed one.
  const app = appWith({
    memories: [RULE_412],
    llmFn: async () => ({
      verdicts: [{ ruleId: 999, violated: true, evidence: 'made up', fix: 'x' }],
    }),
  });
  const { json } = await post(app, '/api/compliance/check', PAYLOAD);
  assert.equal(json.outcome, 'clean');
  assert.deepEqual(json.violations, []);
});

test('a request with no assistant text is rejected rather than judged', async () => {
  const app = appWith({ memories: [RULE_412], llmFn: async () => ({ verdicts: [] }) });
  const { status } = await post(app, '/api/compliance/check', { ...PAYLOAD, assistant_text: '   ' });
  assert.equal(status, 400);
});

test('feedback records the verdict against the check', async () => {
  const inserts = [];
  const app = appWith({ memories: [], llmFn: async () => ({ verdicts: [] }), inserts });
  const { json } = await post(app, '/api/compliance/feedback', { check_id: 77, verdict: 'false_positive' });
  assert.equal(json.ok, true);
  assert.match(JSON.stringify(inserts[0].params), /false_positive/);
});

test('feedback refuses a verdict it does not recognise', async () => {
  const app = appWith({ memories: [], llmFn: async () => ({ verdicts: [] }) });
  const { status } = await post(app, '/api/compliance/feedback', { check_id: 77, verdict: 'meh' });
  assert.equal(status, 400);
});
