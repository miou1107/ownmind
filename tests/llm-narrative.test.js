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

  // v1.30.3 — the judge has to be able to name its model and pin its temperature, and to find
  // out which model actually answered. The switch substitutes silently: asking it for
  // gemini-2.0-flash, llama-3.3-70b or gpt-4o all came back served by mistral-small-latest,
  // HTTP 200, no hint. Everything below defaults to what the narrative writer already sent, so
  // that caller is unchanged.
  it('sends the model and temperature it is given', async () => {
    let sent = null;
    await callLLMSwitch({
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'x' }],
      model: 'gpt-oss-120b',
      temperature: 0,
      fetchImpl: async (_u, opts) => {
        sent = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
      },
      apiBase: 'https://example.com/llm-switch/v1',
    });
    assert.equal(sent.model, 'gpt-oss-120b');
    assert.equal(sent.temperature, 0);
  });

  it('still sends what it always sent when nothing is given', async () => {
    let sent = null;
    await callLLMSwitch({
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async (_u, opts) => {
        sent = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
      },
      apiBase: 'https://example.com/llm-switch/v1',
    });
    assert.equal(sent.model, 'auto');
    assert.equal(sent.temperature, 0.3);
  });

  it('reports which model actually answered, which is not always the one asked for', async () => {
    const served = [];
    await callLLMSwitch({
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'x' }],
      model: 'gpt-4o',
      onServed: (m) => served.push(m),
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ model: 'mistral-small-latest', choices: [{ message: { content: '{}' } }] }),
      }),
      apiBase: 'https://example.com/llm-switch/v1',
    });
    assert.deepEqual(served, ['mistral-small-latest']);
  });

  it('non-2xx upstream throws Error including the status', async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    });
    await assert.rejects(
      () => callLLMSwitch({ apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: 'https://example.com/llm-switch/v1', retries: 0 }),
      /503/
    );
  });
});

/**
 * v1.26.140 — the 14-day and 30-day 整體分析 reports failed whenever the shared gateway was
 * busy, and the page showed an error rather than a report.
 *
 * Measured on production 2026-08-11. The same 35,301-byte body that the route builds for the
 * 14-day range came back 502 from the route four times running at 01:03–01:12 UTC, then
 * succeeded on every one of three sequential and three concurrent replays twenty minutes
 * later, and the endpoint itself then answered 200 five times in a row. A 40,214-byte probe
 * body went through during the same window in which 35,301 was refused, so size is not what
 * decides it — the gateway's capacity at that moment is.
 *
 * The 7-day range kept working throughout because it is smaller (31,929 bytes) and slips
 * under whatever budget was left. That is why this looked like a size limit in v1.26.137.
 *
 * A failure that resolves itself in seconds should cost the reader a slower report, not a
 * missing one.
 */
describe('callLLMSwitch — retrying a gateway that is momentarily out of capacity', () => {
  const base = 'https://example.com/llm-switch/v1';
  const ok = {
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"summary_one_line":"hi"}' } }] }),
  };

  it('a 502 that succeeds on the next attempt returns the report', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 502, text: async () => 'All 3 provider attempts failed' };
      return ok;
    };
    const out = await callLLMSwitch({
      apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: base, retryDelayMs: 0,
    });
    assert.equal(out.summary_one_line, 'hi');
    assert.equal(calls, 2);
  });

  it('a network error that clears on the next attempt returns the report', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error('fetch failed');
      return ok;
    };
    const out = await callLLMSwitch({
      apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: base, retryDelayMs: 0,
    });
    assert.equal(out.summary_one_line, 'hi');
    assert.equal(calls, 2);
  });

  it('gives up after the configured number of retries', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return { ok: false, status: 502, text: async () => 'still busy' };
    };
    await assert.rejects(
      () => callLLMSwitch({
        apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: base, retries: 2, retryDelayMs: 0,
      }),
      /502/
    );
    assert.equal(calls, 3, 'the first attempt plus two retries');
  });

  /**
   * A rejection the gateway will repeat is not worth waiting for three times. 400 and 401
   * mean the request or the key is wrong, and no amount of retrying changes either.
   */
  it('does not retry a request the gateway will refuse again', async () => {
    for (const status of [400, 401, 403, 404]) {
      let calls = 0;
      const fakeFetch = async () => {
        calls += 1;
        return { ok: false, status, text: async () => 'nope' };
      };
      await assert.rejects(
        () => callLLMSwitch({
          apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: base, retries: 2, retryDelayMs: 0,
        }),
        new RegExp(String(status))
      );
      assert.equal(calls, 1, `${status} should be attempted once`);
    }
  });

  it('retries 429, which is the gateway saying "not right now"', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, text: async () => 'rate limited' };
      return ok;
    };
    const out = await callLLMSwitch({
      apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: base, retryDelayMs: 0,
    });
    assert.equal(out.summary_one_line, 'hi');
    assert.equal(calls, 2);
  });

  /**
   * Diagnosing the 502 above needed the request replayed by hand from the server, because
   * the log had been cut off mid-sentence at 200 characters — right where the reason for the
   * second and third provider failing would have been.
   */
  it('keeps enough of the upstream reply to say why every provider failed', async () => {
    const upstream = 'All 3 provider attempts failed: '
      + 'groq/llama-3.3-70b-versatile: 413 Payload Too Large; '.padEnd(400, '.')
      + 'mistral/mistral-small-latest: 429 capacity exceeded, retry after 60s; '
      + 'openai/gpt-4o-mini: 500 upstream unavailable';
    const fakeFetch = async () => ({ ok: false, status: 502, text: async () => upstream });
    await assert.rejects(
      () => callLLMSwitch({
        apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: base, retries: 0, retryDelayMs: 0,
      }),
      (err) => {
        assert.match(err.message, /mistral-small-latest: 429/);
        assert.match(err.message, /gpt-4o-mini: 500/);
        return true;
      }
    );
  });

  /**
   * A real abort, not a hand-built one.
   *
   * The first version of this test threw `Object.assign(new Error(), {name: 'AbortError'})`,
   * and passed against code that could not survive a genuine timeout: an aborted fetch
   * rejects with a DOMException whose `message` is a getter-only accessor, so the line that
   * appended the attempt count threw `TypeError: Cannot set property message` and destroyed
   * the error it was annotating. Both ends of the interface were fabricated, so the fakes
   * only agreed with each other.
   */
  it('a genuine timeout surfaces as a readable error, not as a TypeError', async () => {
    // Honours the signal and does nothing else — this is what a stalled gateway looks like.
    const stallingFetch = (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    });
    await assert.rejects(
      () => callLLMSwitch({
        apiKey: 'sk-x', messages: [], fetchImpl: stallingFetch, apiBase: base,
        timeoutMs: 20, retries: 1, retryDelayMs: 0,
      }),
      (err) => {
        assert.notEqual(err.constructor.name, 'TypeError', err.message);
        assert.match(err.message, /timed out/);
        assert.match(err.message, /after 2 attempts/);
        return true;
      }
    );
  });

  /**
   * Somebody is watching a page while this runs. Three attempts that each time out at 30
   * seconds would hold them there for a minute and a half; retrying is for a gateway that
   * refuses in three seconds, not for one that has stopped answering.
   */
  it('stops retrying once the overall deadline has passed, even with attempts left', async () => {
    let calls = 0;
    let clock = 0;
    const stallingFetch = (url, opts) => new Promise((_, reject) => {
      calls += 1;
      clock += 40_000;   // each attempt stalls until its own timeout
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    });
    await assert.rejects(
      () => callLLMSwitch({
        apiKey: 'sk-x', messages: [], fetchImpl: stallingFetch, apiBase: base,
        timeoutMs: 20, retries: 2, retryDelayMs: 0, overallTimeoutMs: 60_000, now: () => clock,
      }),
      /after 2 attempts/
    );
    assert.equal(calls, 2, 'two stalled attempts reach the 60s deadline; the third is not started');
  });

  /**
   * The classifier used to be a substring match on the error message, and the message
   * carries the model's own output. A report whose text happened to mention a network error
   * was retried three times and then reported as a transport failure.
   */
  /**
   * A gateway under load answers 200 and then stalls streaming the body. That is the same
   * out-of-capacity condition as a 502 and has to stay retryable.
   *
   * Before this was covered, `res.json()` sat outside the try that classifies failures, so
   * the abort escaped as a raw DOMException with `transient` still false: no retry, and a
   * log line reading `DOMException [AbortError]: This operation was aborted` — no attempt
   * count, no URL, nothing about a timeout. The failure C1 was fixed to remove, arriving
   * through a different door.
   */
  it('a body that stalls after the headers arrive is retried', async () => {
    let calls = 0;
    const fakeFetch = async (url, opts) => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          json: () => new Promise((_, reject) => {
            opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
          }),
        };
      }
      return ok;
    };
    const out = await callLLMSwitch({
      apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: base,
      timeoutMs: 20, retries: 1, retryDelayMs: 0,
    });
    assert.equal(out.summary_one_line, 'hi');
    assert.equal(calls, 2);
  });

  it('a body that never finishes is reported readably rather than as a DOMException', async () => {
    const stallingBody = async (url, opts) => ({
      ok: true,
      json: () => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
      }),
    });
    await assert.rejects(
      () => callLLMSwitch({
        apiKey: 'sk-x', messages: [], fetchImpl: stallingBody, apiBase: base,
        timeoutMs: 20, retries: 1, retryDelayMs: 0,
      }),
      (err) => {
        assert.notEqual(err.constructor.name, 'DOMException', err.message);
        assert.match(err.message, /body timed out/);
        assert.match(err.message, /after 2 attempts/);
        return true;
      }
    );
  });

  it('does not retry a 200 whose content is not the JSON that was asked for', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'the gateway had a network error and a socket timeout' } }] }),
      };
    };
    await assert.rejects(
      () => callLLMSwitch({
        apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: base, retries: 2, retryDelayMs: 0,
      }),
      /parse failed/
    );
    assert.equal(calls, 1, 'the gateway answered; asking again produces the same answer');
  });

  it('does not retry a programming error in the response handling', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return { ok: true };   // no json()
    };
    await assert.rejects(
      () => callLLMSwitch({
        apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: base, retries: 2, retryDelayMs: 0,
      }),
      /res\.json is not a function/
    );
    assert.equal(calls, 1);
  });

  it('a connection that never opens is retried', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"summary_one_line":"hi"}' } }] }),
      };
    };
    const out = await callLLMSwitch({
      apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: base, retryDelayMs: 0,
    });
    assert.equal(out.summary_one_line, 'hi');
    assert.equal(calls, 2);
  });

  it('a nonsense retry count still makes one attempt rather than dereferencing nothing', async () => {
    for (const retries of [-1, NaN, undefined]) {
      const fakeFetch = async () => ({ ok: false, status: 502, text: async () => 'busy' });
      await assert.rejects(
        () => callLLMSwitch({
          apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: base, retries, retryDelayMs: 0,
        }),
        (err) => {
          assert.match(err.message, /502/);
          assert.doesNotMatch(err.message, /after 0 attempts/);
          return true;
        },
        `retries: ${retries}`
      );
    }
  });

  /** A base URL that cannot be parsed answers the same way every time. */
  it('does not retry an unusable apiBase', async () => {
    let calls = 0;
    const fakeFetch = async () => { calls += 1; return ok; };
    await assert.rejects(
      () => callLLMSwitch({
        apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: 'not-a-url', retries: 2, retryDelayMs: 0,
      }),
      /Invalid URL|Failed to parse/
    );
    assert.equal(calls, 0, 'a request was never worth sending');
  });

  /**
   * The clock has to move when the fake sleeps, or the test is asking the code to respect a
   * deadline against a clock that never advances — which it would always pass.
   */
  it('does not sleep past the overall deadline between attempts', async () => {
    let clock = 0;
    let elapsedInFetch = 0;
    const fakeFetch = async () => {
      clock += 900;              // each refusal takes 900ms
      elapsedInFetch += 900;
      return { ok: false, status: 502, text: async () => 'busy' };
    };
    await assert.rejects(
      () => callLLMSwitch({
        apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: base,
        retries: 2, retryDelayMs: 3_000, overallTimeoutMs: 1_000,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
      }),
      /502/
    );
    assert.ok(clock <= 1_000, `the call ran to ${clock}ms against a 1000ms deadline`);
    assert.equal(elapsedInFetch, 900, 'one attempt; the deadline stopped the second');
  });

  it('says how many attempts were made, so a slow report is not mistaken for a slow gateway', async () => {
    const fakeFetch = async () => ({ ok: false, status: 502, text: async () => 'busy' });
    await assert.rejects(
      () => callLLMSwitch({
        apiKey: 'sk-x', messages: [], fetchImpl: fakeFetch, apiBase: base, retries: 2, retryDelayMs: 0,
      }),
      /3 attempts/
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
