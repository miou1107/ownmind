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
