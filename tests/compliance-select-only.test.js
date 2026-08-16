/**
 * The half of the reply check that does not need a model.
 *
 * WHY THIS EXISTS. The judge is moving off the llm switch and onto the user's own Claude Code
 * subscription (IR-160), which means it has to run on the user's machine — that is where the
 * quota lives. But the rules do not: measured 2026-08-16, the client's enforcement cache holds
 * 318 selectors and **zero** rule text. Shipping the whole corpus to every machine is a much
 * larger change than moving the judging.
 *
 * So the work splits where the cost does. Matching rules to a turn is a database query and
 * some ranking — cheap, deterministic, already tested, and it stays on the server. Judging is
 * the expensive, flaky, quota-spending part, and only that moves.
 *
 * This is the server half: answer "which rules apply to this reply, and what do they say",
 * make no model call at all, and open a row for the verdict that will arrive later.
 *
 * The `llmFn` injected below THROWS. That is the point of it — a select-only request that
 * reaches the judge would otherwise pass its assertions while quietly still spending the
 * switch, which is the exact thing IR-160 forbids.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createComplianceRouter } from '../src/routes/compliance.js';
import { startServer } from './helpers/app-server.js';

const RULE_795 = {
  id: 795,
  type: 'iron_rule',
  code: 'IR-125',
  title: '跟使用者講話要先講結論',
  content: '第一句就是結論。不要報工作過程、不要用行話。',
  tags: ['trigger:always'],
  metadata: { enforcement: { always_check: true } },
};

const RULE_412 = {
  id: 412,
  type: 'team_standard',
  title: 'ci ownership',
  content: 'Only the colleague may edit ci/.',
  tags: [],
  metadata: { enforcement: { keywords: ['FAPA'] } },
};

const PAYLOAD = {
  session_id: 's1',
  turn_index: 1,
  assistant_text: '我先看了 A 檔案，又看了 B 檔案，跑了三次測試，最後發現問題在第 42 行。',
  user_prompts: ['migrate ownmind to FAPA'],
  repo_remote: null,
};

/** An llmFn that fails the test if anything reaches it. */
const noJudge = () => {
  throw new Error('the select-only path must not call a model');
};

function appWith({ mode = 'check', memories = [], inserts = [], llmFn = noJudge }) {
  const queryFn = async (sql, params) => {
    if (/FROM users/i.test(sql)) return { rows: [{ enforcement_mode: mode }] };
    if (/INSERT INTO compliance_checks/i.test(sql)) {
      inserts.push({ sql, params });
      return { rows: [{ id: 77 }] };
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

test('select-only returns the rules that apply, with the text needed to judge them', async () => {
  const inserts = [];
  const app = appWith({ memories: [RULE_795, RULE_412], inserts });
  const { status, json } = await post(app, '/api/compliance/check', { ...PAYLOAD, mode: 'select' });

  assert.equal(status, 200);
  assert.equal(json.enabled, true);
  assert.equal(json.outcome, 'pending', 'nothing has been judged yet');
  assert.ok(Array.isArray(json.rules), 'the client needs the rules themselves, not a count');
  assert.ok(json.rules.length > 0);

  const rule = json.rules.find((r) => r.id === 795);
  assert.ok(rule, 'an always_check rule applies to every turn');
  assert.equal(typeof rule.judgeText, 'string');
  assert.ok(rule.judgeText.includes('第一句就是結論'),
    'the text has to travel — the client has selectors and no rule bodies');
  assert.equal(rule.title, '跟使用者講話要先講結論');
});

test('it opens a row for the verdict that has not happened yet', async () => {
  const inserts = [];
  const app = appWith({ memories: [RULE_795], inserts });
  const { json } = await post(app, '/api/compliance/check', { ...PAYLOAD, mode: 'select' });

  assert.equal(typeof json.check_id, 'number', 'the client reports the verdict against this');
  assert.equal(inserts.length, 1, 'exactly one row, opened now');
  assert.ok(inserts[0].params.includes('pending'),
    'and it says pending — a row with no outcome would read as a check that passed');
});

test('nothing on this path calls a model', async () => {
  // The assertion is the injected llmFn: it throws, so reaching the judge fails the request
  // rather than quietly spending the switch. Kept as its own test because the two above would
  // still pass if the route judged first and then answered.
  const app = appWith({ memories: [RULE_795, RULE_412] });
  const { status, json } = await post(app, '/api/compliance/check', { ...PAYLOAD, mode: 'select' });
  assert.equal(status, 200);
  assert.notEqual(json.outcome, 'failed', 'a thrown judge would have landed here');
});

test('an account with enforcement off is still off', async () => {
  const app = appWith({ mode: 'off', memories: [RULE_795] });
  const { json } = await post(app, '/api/compliance/check', { ...PAYLOAD, mode: 'select' });
  assert.equal(json.enabled, false);
  assert.equal(json.outcome, 'skipped');
});

test('a turn that matches no rule says so rather than returning an empty list', async () => {
  // "nothing applied" and "the selection broke" must not look alike on the client, which is
  // about to decide whether to spend the user's quota on the answer.
  const app = appWith({ memories: [RULE_412] });   // keyword rule, and the reply lacks it
  const { json } = await post(app, '/api/compliance/check', {
    ...PAYLOAD, mode: 'select', user_prompts: [], assistant_text: '好，我改好了。',
  });
  assert.equal(json.outcome, 'skipped');
  assert.deepEqual(json.rules, []);
});

test('the judging path is untouched by the new mode', async () => {
  // The release that adds this must not change what anyone already gets. No mode, old
  // behaviour — including actually calling the judge.
  let called = 0;
  const app = appWith({
    memories: [RULE_795],
    llmFn: async () => { called += 1; return { verdicts: [] }; },
  });
  const { json } = await post(app, '/api/compliance/check', PAYLOAD);
  assert.equal(called, 1, 'the default path still judges');
  assert.equal(json.outcome, 'clean');
  assert.equal(json.rules, undefined, 'and it does not start shipping rule text to everyone');
});
