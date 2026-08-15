import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJudgeCaller, JUDGE_MODELS } from '../src/lib/enforcement/judge-llm.js';

/**
 * Which model judges a reply, and what happens when it will not answer.
 *
 * Measured against the live switch on 2026-08-15, because the whole reason this file exists is
 * that nobody had looked:
 *
 *   - The judge asked for `model: 'auto'`. The switch's catalogue has 71 entries including OCR,
 *     speech and embedding models, and production logs show `mistral/mistral-ocr-3-0` served
 *     compliance checks. An OCR model cannot audit a reply.
 *   - Under 'auto', 13 of 16 checks were served by mistral-small-latest, which flagged 8 of 8
 *     replies written to follow the rules — it flags everything, so a violation carries no
 *     information. Pinned to gpt-oss-120b the same eight samples flagged 1 of 4 good ones and
 *     caught 3 of 3 bad ones. Small numbers, one eval set, my labels: enough to prefer a model,
 *     not enough to call the problem solved.
 *   - Asking for a model is not getting it. gemini-2.0-flash, llama-3.3-70b and gpt-4o were all
 *     answered by mistral-small-latest. Only gpt-oss-120b was honoured, and it comes back
 *     provider-prefixed as `openai/gpt-oss-120b`.
 */

const MESSAGES = [{ role: 'user', content: 'audit this' }];
const ANSWER = { verdicts: [] };
const PINNED = JUDGE_MODELS[0];

function stubCall(plan) {
  const seen = [];
  const call = async ({ model, temperature, timeoutMs }) => {
    seen.push({ model, temperature, timeoutMs });
    const step = plan[seen.length - 1];
    if (step instanceof Error) throw step;
    return step;
  };
  return { call, seen };
}

describe('the judge names the model it wants', () => {
  it('asks for the pinned model, not for whatever the switch feels like', async () => {
    const { call, seen } = stubCall([{ parsed: ANSWER, served: `openai/${PINNED}` }]);
    await createJudgeCaller({ callLLM: call })(MESSAGES);
    assert.equal(seen[0].model, PINNED);
  });

  it('and asks for it deterministically', async () => {
    // The judge inherited temperature 0.3 from the narrative writer, where variety is the
    // point. Here it means the same reply can be judged differently on two consecutive turns,
    // which was measured happening: clean, clean, violation, violation on one unchanged text.
    const { call, seen } = stubCall([{ parsed: ANSWER, served: `openai/${PINNED}` }]);
    await createJudgeCaller({ callLLM: call })(MESSAGES);
    assert.equal(seen[0].temperature, 0);
  });
});

describe('a pin nobody verifies is not a pin', () => {
  it('accepts the provider prefix the switch actually returns', async () => {
    // The switch answers `openai/gpt-oss-120b` for `gpt-oss-120b`. A bare-string compare made
    // the warning fire on every honoured pin, which turns the one instrument that answers "did
    // the pin take?" into noise, and hides the substitution it exists to catch.
    const warned = [];
    const { call } = stubCall([{ parsed: ANSWER, served: `openai/${PINNED}` }]);
    await createJudgeCaller({ callLLM: call, onSubstitution: (a, b) => warned.push([a, b]) })(MESSAGES);
    assert.deepEqual(warned, [], 'a prefixed name is the same model, not a substitution');
  });

  it('notices when the switch serves something else entirely', async () => {
    const warned = [];
    const { call } = stubCall([{ parsed: ANSWER, served: 'mistral/mistral-small-latest' }]);
    const out = await createJudgeCaller({
      callLLM: call, onSubstitution: (a, b) => warned.push([a, b]),
    })(MESSAGES);
    assert.deepEqual(out, ANSWER);
    assert.deepEqual(warned, [[PINNED, 'mistral/mistral-small-latest']]);
  });

  it('does not mistake a missing served name for a substitution', async () => {
    const warned = [];
    const { call } = stubCall([{ parsed: ANSWER, served: undefined }]);
    await createJudgeCaller({ callLLM: call, onSubstitution: (a, b) => warned.push([a, b]) })(MESSAGES);
    assert.deepEqual(warned, []);
  });
});

describe('when the model will not answer', () => {
  it('says which model refused, because the upstream error never does', async () => {
    // Real errors read `LLM upstream 502: <body>` and `LLM request timed out after 4000ms`.
    // Neither carries a model name, so without this the log cannot say who was asked.
    const { call } = stubCall([new Error('LLM upstream 502: busy')]);
    await assert.rejects(
      () => createJudgeCaller({ callLLM: call })(MESSAGES),
      (err) => err.message.includes(PINNED) && err.message.includes('502'),
    );
  });

  it('does not seat a second-choice judge', async () => {
    // mistral-small-latest is the model measured to flag 8 of 8 compliant replies. Falling back
    // to it would hand the user a confident wrong verdict on the majority path — pinned models
    // 502 in 9 of 16 calls — in a ratio nothing records, which is this release's own defect one
    // layer down. A check that did not run is visible, recorded failed, and left out of the
    // false-positive count.
    assert.equal(JUDGE_MODELS.length, 1, 'a second entry needs its own measured false-alarm rate');
    const { call, seen } = stubCall([new Error('LLM upstream 502')]);
    await assert.rejects(() => createJudgeCaller({ callLLM: call })(MESSAGES));
    assert.equal(seen.length, 1);
  });

  it('gives a later attempt what is left of the budget, never the whole budget again', async () => {
    const { call, seen } = stubCall([new Error('502'), { parsed: ANSWER, served: 'b' }]);
    let clock = 0;
    await createJudgeCaller({
      callLLM: async (args) => { clock += 1500; return call(args); },
      models: ['a', 'b'],
      timeoutMs: 4000,
      now: () => clock,
    })(MESSAGES);
    assert.equal(seen[0].timeoutMs, 4000);
    assert.equal(seen[1].timeoutMs, 2500, 'the second attempt gets the remainder, not a fresh 4000');
  });

  it('will not start an attempt that can only time out', async () => {
    // A `remaining > 0` guard started a second attempt with 5ms left. It timed out, and being
    // the last error it replaced `LLM upstream 502: <provider text>` in the log with
    // "timed out after 5ms" — losing exactly the diagnosis this was built to keep.
    const { call, seen } = stubCall([new Error('LLM upstream 502: the real reason'), new Error('502')]);
    let clock = 0;
    await assert.rejects(
      () => createJudgeCaller({
        callLLM: async (args) => { clock += 3995; return call(args); },
        models: ['a', 'b'],
        timeoutMs: 4000,
        now: () => clock,
      })(MESSAGES),
      /the real reason/,
    );
    assert.equal(seen.length, 1, 'the second attempt had 5ms and was not started');
  });

  it('keeps the budget guard honest when nothing has failed yet', async () => {
    // The first attempt must run even though `remaining` is the full budget and no error has
    // been recorded — deleting the `lastError &&` clause must therefore change behaviour.
    const { call, seen } = stubCall([{ parsed: ANSWER, served: 'a' }]);
    let clock = 0;
    await createJudgeCaller({
      callLLM: call, models: ['a'], timeoutMs: 4000, now: () => { clock += 5000; return clock; },
    })(MESSAGES);
    assert.equal(seen.length, 1, 'a first attempt is never skipped for budget');
  });
});

describe('a bug in this file is not the upstream being busy', () => {
  it('lets a programming error out instead of asking the next model about it', async () => {
    // The first draft of this whole feature referenced a constant that did not exist, inside a
    // catch that swallowed the ReferenceError: every check would have been recorded as failed
    // with the suite green.
    //
    // Asserted on the attempt count, not on the error type. With one model in the list a
    // swallowed TypeError is still rethrown at the end, so the type alone cannot tell the two
    // behaviours apart — the first version of this test passed against the bug it was written
    // for, and the mutation run is what said so.
    let calls = 0;
    const judge = createJudgeCaller({
      models: ['a', 'b'],
      callLLM: async () => { calls += 1; throw new TypeError('x is not a function'); },
    });
    await assert.rejects(() => judge(MESSAGES), TypeError);
    assert.equal(calls, 1, 'a bug in this file must not be retried against another model');
  });

  it('and does not dress it up as an upstream refusal', async () => {
    const judge = createJudgeCaller({ callLLM: async () => { throw new ReferenceError('DISABLED is not defined'); } });
    await assert.rejects(() => judge(MESSAGES), (err) => {
      assert.ok(err instanceof ReferenceError);
      assert.doesNotMatch(err.message, /\[/, 'a model tag would make this read as the judge refusing');
      return true;
    });
  });
});

describe('the model list itself', () => {
  it('names only models the switch was measured to honour', () => {
    assert.deepEqual(JUDGE_MODELS, ['gpt-oss-120b']);
  });

  it('screens out anything that cannot audit text', () => {
    // The rotation that produced this bug included mistral-ocr. Asserted through the predicate
    // rather than beside the literal above, so this is the assertion that fails when somebody
    // reaches for a speech, vision or embedding model.
    const cannotAudit = /ocr|voxtral|whisper|stt|tts|embed|rerank|vision|image/i;
    for (const m of JUDGE_MODELS) assert.doesNotMatch(m, cannotAudit, `${m} cannot audit a reply`);
    for (const bad of ['mistral-ocr-latest', 'voxtral-mini-tts-latest', 'mistral-embed', 'whisper-large']) {
      assert.match(bad, cannotAudit, `the screen must reject ${bad}`);
    }
  });
});
