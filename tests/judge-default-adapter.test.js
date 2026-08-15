import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultJudge } from '../src/routes/compliance.js';
import { JUDGE_MODELS } from '../src/lib/enforcement/judge-llm.js';

/**
 * The adapter between the judge and the gateway — the seam every other test injects past.
 *
 * `createComplianceRouter` takes an `llmFn`, and every route test supplies one, so the real
 * path from "judge wants a model" to "these bytes go on the wire" had no test at all. That is
 * the same shape as the defect the route file's own comment describes: an earlier draft read
 * `.content` off the wrong object, would have recorded every check as failed, and its tests —
 * which injected a stub — stayed green.
 *
 * Nothing here is stubbed except `fetch`. The prompt goes through the real callLLMSwitch, so
 * what is asserted is the body that would actually be posted.
 */

const MESSAGES = [{ role: 'user', content: 'audit this' }];
const ok = (content, model) => ({
  ok: true,
  status: 200,
  json: async () => ({ model, choices: [{ message: { content } }] }),
});

describe('what actually goes on the wire', () => {
  it('names the pinned model and pins the temperature', async () => {
    let sent = null;
    const judge = createDefaultJudge({
      apiKey: () => 'sk-test',
      fetchImpl: async (_url, opts) => { sent = JSON.parse(opts.body); return ok('{"verdicts":[]}', `openai/${JUDGE_MODELS[0]}`); },
    });
    process.env.OWNMIND_LLM_API_BASE ||= 'https://example.com/llm-switch/v1';
    await judge(MESSAGES);
    assert.equal(sent.model, JUDGE_MODELS[0]);
    assert.equal(sent.temperature, 0);
    assert.equal(sent.response_format.type, 'json_object');
  });

  it('hands back the parsed answer, not the envelope around it', async () => {
    // The bug this guards: reading `.content` and getting undefined, so every verdict list is
    // empty and every check quietly passes.
    const judge = createDefaultJudge({
      apiKey: () => 'sk-test',
      fetchImpl: async () => ok('{"verdicts":[{"ruleId":7,"violated":true,"evidence":"x"}]}', JUDGE_MODELS[0]),
    });
    const out = await judge(MESSAGES);
    assert.deepEqual(out, { verdicts: [{ ruleId: 7, violated: true, evidence: 'x' }] });
  });

  it('says nothing when the switch honours the pin, prefix and all', async () => {
    const warnings = [];
    const judge = createDefaultJudge({
      apiKey: () => 'sk-test',
      warn: (...a) => warnings.push(a),
      fetchImpl: async () => ok('{"verdicts":[]}', `openai/${JUDGE_MODELS[0]}`),
    });
    await judge(MESSAGES);
    assert.deepEqual(warnings, [], 'a warning on every healthy turn is a warning nobody reads');
  });

  it('warns when the switch quietly serves a different model', async () => {
    // Measured: asking for gemini-2.0-flash, llama-3.3-70b or gpt-4o all came back as
    // mistral-small-latest, HTTP 200, no indication. Without this the pin is a comment.
    const warnings = [];
    const judge = createDefaultJudge({
      apiKey: () => 'sk-test',
      warn: (...a) => warnings.push(a),
      fetchImpl: async () => ok('{"verdicts":[]}', 'mistral/mistral-small-latest'),
    });
    await judge(MESSAGES);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /substituted/);
    assert.deepEqual(warnings[0][1], { asked: JUDGE_MODELS[0], served: 'mistral/mistral-small-latest' });
  });

  it('replays a refusal once rather than losing the turn to it', async () => {
    // The gateway refuses the same body and then accepts it on replay; that is what the one
    // retry is for. It is inside the same budget, so nobody waits longer for the answer.
    let calls = 0;
    const judge = createDefaultJudge({
      apiKey: () => 'sk-test',
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 502, text: async () => 'busy' };
        return ok('{"verdicts":[]}', JUDGE_MODELS[0]);
      },
    });
    const out = await judge(MESSAGES);
    assert.deepEqual(out, { verdicts: [] });
    assert.equal(calls, 2);
  });

  it('gives up rather than handing the turn to a different judge', async () => {
    const judge = createDefaultJudge({
      apiKey: () => 'sk-test',
      fetchImpl: async () => ({ ok: false, status: 502, text: async () => 'still busy' }),
    });
    await assert.rejects(() => judge(MESSAGES), (err) => err.message.includes(JUDGE_MODELS[0]));
  });
});
