import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, parseLLMJson, computeDataHash, callLLMSwitch } from '../src/lib/llm-narrative.js';

describe('buildMessages', () => {
  it('回傳 system + user 兩條 message', () => {
    const msgs = buildMessages({ ranking: [], versions: [] });
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[1].role, 'user');
    assert.match(msgs[0].content, /OwnMind/);
    assert.match(msgs[0].content, /summary_one_line/);
  });

  it('user message 帶完整 JSON', () => {
    const msgs = buildMessages({ x: 1 });
    assert.equal(msgs[1].content, '{"x":1}');
  });

  // v1.17.54: prompt 規格 pin — friction 三段式、不准用行話
  it('prompt 要求 friction 三段式（what/impact/mitigation）', () => {
    const msgs = buildMessages({});
    const sys = msgs[0].content;
    assert.match(sys, /what.*impact.*mitigation/s);
    assert.match(sys, /影響不確定/);
    assert.match(sys, /需找 PM 釐清根因/);
  });

  it('prompt 禁用行話清單包含「大使」「賦能」「對齊」', () => {
    const sys = buildMessages({})[0].content;
    assert.match(sys, /不要用行話/);
    assert.match(sys, /大使/);
    assert.match(sys, /賦能/);
    assert.match(sys, /對齊/);
  });

  it('prompt rule 2 範例用「AI 工作量」+ 比例 + 角色定位（非「大使人選」）', () => {
    const sys = buildMessages({})[0].content;
    assert.match(sys, /AI 工作量/);
    assert.doesNotMatch(sys, /大使人選/);
  });

  // v1.17.57: 高貢獻者改正面肯定，禁止個人風險評價（離職、接不下去、扛太多）
  it('prompt 禁止個人風險評價、要求正面肯定高貢獻者', () => {
    const sys = buildMessages({})[0].content;
    assert.match(sys, /主要開發者|貢獻極大|認真/);
    assert.match(sys, /禁止|不要|不寫/);
    assert.match(sys, /離職|扛太多|接不下去/);
  });
});

describe('parseLLMJson', () => {
  it('純 JSON 直接解析', () => {
    const out = parseLLMJson('{"summary_one_line":"x"}');
    assert.equal(out.summary_one_line, 'x');
  });

  it('用 ```json 包圍也能解析', () => {
    const out = parseLLMJson('```json\n{"summary_one_line":"y"}\n```');
    assert.equal(out.summary_one_line, 'y');
  });

  it('用 ``` 不帶 lang 也能解析', () => {
    const out = parseLLMJson('```\n{"a":1}\n```');
    assert.equal(out.a, 1);
  });

  it('parse 失敗丟 Error 含 raw 前 200 字', () => {
    assert.throws(() => parseLLMJson('not json'), /raw/);
  });
});

describe('computeDataHash', () => {
  it('同樣 input、key 順序不同也產同 hash', () => {
    const a = computeDataHash({ x: 1, y: 2 });
    const b = computeDataHash({ y: 2, x: 1 });
    assert.equal(a, b);
  });

  it('不同 input 不同 hash', () => {
    assert.notEqual(computeDataHash({ x: 1 }), computeDataHash({ x: 2 }));
  });

  it('回傳 sha256 hex（64 char）', () => {
    const h = computeDataHash({ a: 1 });
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it('巢狀物件 + 陣列也穩定', () => {
    const a = computeDataHash({ list: [{ x: 1, y: 2 }, { z: 3 }] });
    const b = computeDataHash({ list: [{ y: 2, x: 1 }, { z: 3 }] });
    assert.equal(a, b);
  });
});

describe('callLLMSwitch', () => {
  it('沒 apiKey 丟 Error', async () => {
    await assert.rejects(
      () => callLLMSwitch({ apiKey: '', messages: [] }),
      /API_KEY|api.*key/i
    );
  });

  it('200 OK 解析回 JSON', async () => {
    const fakeFetch = async (url, opts) => {
      assert.equal(url, 'https://kkvin.com/llm-switch/v1/chat/completions');
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
    });
    assert.equal(out.summary_one_line, 'hi');
  });

  it('upstream 非 2xx 丟 Error 含 status', async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    });
    await assert.rejects(
      () => callLLMSwitch({ apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch }),
      /503/
    );
  });
});
