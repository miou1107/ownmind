import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, parseLLMJson, computeDataHash, callLLMSwitch } from '../src/lib/llm-narrative.js';

describe('buildMessages', () => {
  it('returns two messages: system + user', () => {
    const msgs = buildMessages({ ranking: [], versions: [] });
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[1].role, 'user');
    assert.match(msgs[0].content, /OwnMind/);
    assert.match(msgs[0].content, /summary_one_line/);
  });

  it('user message carries the full JSON', () => {
    const msgs = buildMessages({ x: 1 });
    assert.equal(msgs[1].content, '{"x":1}');
  });

  // v1.17.54: pin the prompt spec — friction must be three-part, jargon forbidden.
  it('prompt requires the three-part friction format (what/impact/mitigation)', () => {
    const msgs = buildMessages({});
    const sys = msgs[0].content;
    assert.match(sys, /what.*impact.*mitigation/s);
    assert.match(sys, /影響不確定/);
    assert.match(sys, /需找 PM 釐清根因/);
  });

  it('prompt jargon-blocklist contains "大使", "賦能", "對齊"', () => {
    const sys = buildMessages({})[0].content;
    assert.match(sys, /不要用行話/);
    assert.match(sys, /大使/);
    assert.match(sys, /賦能/);
    assert.match(sys, /對齊/);
  });

  it('prompt rule 2 example uses "AI 工作量" + ratio + role framing (not "大使人選")', () => {
    const sys = buildMessages({})[0].content;
    assert.match(sys, /AI 工作量/);
    assert.doesNotMatch(sys, /大使人選/);
  });

  // v1.17.57: high contributors must be praised, personal-risk framing is forbidden (resignation, burn-out, carrying too much).
  it('prompt forbids personal-risk framing and requires positive recognition for high contributors', () => {
    const sys = buildMessages({})[0].content;
    assert.match(sys, /主要開發者|貢獻極大|認真/);
    assert.match(sys, /禁止|不要|不寫/);
    assert.match(sys, /離職|扛太多|接不下去/);
  });
});

describe('parseLLMJson', () => {
  it('pure JSON is parsed directly', () => {
    const out = parseLLMJson('{"summary_one_line":"x"}');
    assert.equal(out.summary_one_line, 'x');
  });

  it('still parses when wrapped in ```json fences', () => {
    const out = parseLLMJson('```json\n{"summary_one_line":"y"}\n```');
    assert.equal(out.summary_one_line, 'y');
  });

  it('still parses with bare ``` fences (no language tag)', () => {
    const out = parseLLMJson('```\n{"a":1}\n```');
    assert.equal(out.a, 1);
  });

  it('parse failure throws Error containing the first 200 chars of raw', () => {
    assert.throws(() => parseLLMJson('not json'), /raw/);
  });
});

describe('computeDataHash', () => {
  it('same input with different key order produces the same hash', () => {
    const a = computeDataHash({ x: 1, y: 2 });
    const b = computeDataHash({ y: 2, x: 1 });
    assert.equal(a, b);
  });

  it('different input produces different hash', () => {
    assert.notEqual(computeDataHash({ x: 1 }), computeDataHash({ x: 2 }));
  });

  it('returns sha256 hex (64 chars)', () => {
    const h = computeDataHash({ a: 1 });
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it('stable across nested objects + arrays', () => {
    const a = computeDataHash({ list: [{ x: 1, y: 2 }, { z: 3 }] });
    const b = computeDataHash({ list: [{ y: 2, x: 1 }, { z: 3 }] });
    assert.equal(a, b);
  });
});

describe('callLLMSwitch', () => {
  it('missing apiKey throws Error', async () => {
    await assert.rejects(
      () => callLLMSwitch({ apiKey: '', messages: [] }),
      /API_KEY|api.*key/i
    );
  });

  it('200 OK parses response as JSON', async () => {
    const fakeFetch = async (url, opts) => {
      assert.equal(url, 'https://example.com/llm-switch/v1/chat/completions');
      assert.equal(opts.method, 'POST');
      assert.match(opts.headers.Authorization, /^Bearer sk-/);
      const body = JSON.parse(opts.body);
      assert.equal(body.model, 'auto');
      assert.equal(body.response_format.type, 'json_object');
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"summary_one_line":"hi"}' } }] }),
      };
    };
    const out = await callLLMSwitch({
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: fakeFetch,
      apiBase: 'https://example.com/llm-switch/v1',
    });
    assert.equal(out.summary_one_line, 'hi');
  });

  it('non-2xx upstream throws Error including the status', async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    });
    await assert.rejects(
      () => callLLMSwitch({ apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: 'https://example.com/llm-switch/v1' }),
      /503/
    );
  });
});

// v1.26.47 — the prompt must not ask the model to count.
//
// v1.26.46 added a rule telling it to open the ranking note with
// 「有 N 位成員從來沒有回報過、排名不含他們」. On production it then said that sentence even
// though every member was instrumented, inventing "有 8 位成員從來沒有回報過任何資料" while
// six of the nine were actively using OwnMind. The instruction meant to stop a confident
// false statement produced one instead.
//
// The count is exact in the UI, which renders it from the same rows. Prose restating a
// number it has to derive itself is the part that goes wrong, so the prompt now forbids it.
describe('the ranking prompt does not ask the model to count members', () => {
  const systemPrompt = () => buildMessages({ ranking: [] })[0].content;

  it('still explains what measured=false means', () => {
    const p = systemPrompt();
    assert.match(p, /measured=false/, 'the model still has to know not to rank unmeasured members');
    assert.match(p, /measured=true/, 'and that an in-period zero for an instrumented member is a real zero');
  });

  it('forbids counting and forbids claiming the ranking is complete or incomplete', () => {
    const p = systemPrompt();
    assert.match(p, /不要自己數/, 'the prompt must tell it not to count');
    assert.match(p, /排名完整或不完整/, 'and not to characterise the ranking coverage');
  });

  it('no longer carries the template that produced the invented number', () => {
    const p = systemPrompt();
    assert.doesNotMatch(
      p,
      /有 N 位成員/,
      'this template is what the model filled in with a number it made up',
    );
  });
});
