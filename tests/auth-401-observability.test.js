import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * v1.17.68 — auth.js 401 觀測管道（IR-038）
 *
 * 背景：Adam 從 2026-03-26 建帳號到 2026-05-08 都吃 401，因為他 settings.json 裡
 * OWNMIND_API_KEY 是字串 "--update"（v1.17.9 之前 install.ps1 沒過濾 flag-like
 * args 的存量問題）。期間 token_events 表 0 筆 / install_check_logs 0 筆 / scanner
 * 永遠 401，沒人發現是因為 server 端 auth 401 path 沒留任何結構化 log，admin 從
 * docker logs 裡只看到 access log 「POST /api/usage/events 401 3ms」，看不出是誰、
 * 也看不到 key prefix 能跟 users 表反查。
 *
 * 修法：auth.js 401 path 呼叫 logger.warn('auth_failed', {...}) 帶 path / ip /
 * masked key prefix-suffix / ua；同時 export maskApiKey() 純函式給測試覆蓋。
 */

describe('v1.17.68 — auth.js maskApiKey() 純函式', () => {
  it('module 應 export maskApiKey', async () => {
    const mod = await import('../src/middleware/auth.js');
    assert.equal(typeof mod.maskApiKey, 'function',
      'auth.js 必須 export maskApiKey 給觀測 / 測試用');
  });

  it('空字串 / null / undefined → "<empty>"', async () => {
    const { maskApiKey } = await import('../src/middleware/auth.js');
    assert.equal(maskApiKey(''), '<empty>');
    assert.equal(maskApiKey(null), '<empty>');
    assert.equal(maskApiKey(undefined), '<empty>');
  });

  it('長度 < 12 → 「<too-short:N>」（不能洩漏短 key 全文）', async () => {
    const { maskApiKey } = await import('../src/middleware/auth.js');
    assert.equal(maskApiKey('abc'), '<too-short:3>');
    assert.equal(maskApiKey('1234567'), '<too-short:7>');
    assert.equal(maskApiKey('12345678901'), '<too-short:11>');
  });

  it('Adam 的 "--update" (8 char) 走 too-short 路徑、不能 reconstruct 出全文', async () => {
    const { maskApiKey } = await import('../src/middleware/auth.js');
    const out = maskApiKey('--update');
    // v1.17.68 reviewer 抓到：原本 len < 8 的門檻讓 8 char key 走
    // slice(0,4)+'...'+slice(-4) → '--up...date'，把三個點移掉就是原文。
    // 提高門檻到 12 後 8 char 走 <too-short:8>，admin 從 log 看不到全文。
    assert.equal(out, '<too-short:8>',
      '8 char key 必須走 too-short 路徑、不能讓 mask 形成 prefix...suffix 拼回原文');
    assert.ok(!out.includes('update'), '不能含原 key 任何 substring');
    assert.ok(!out.includes('--up'), '不能含原 key 任何 substring');
  });

  it('len=12 邊界：剛好走 prefix...suffix 路徑、有真的遮到中間 4 char', async () => {
    const { maskApiKey } = await import('../src/middleware/auth.js');
    const out = maskApiKey('aaaaXXXXbbbb');
    assert.equal(out, 'aaaa...bbbb (len=12)');
    // 中間 XXXX 有確實被點點蓋掉
    assert.ok(!out.includes('XXXX'), '中間 4 char 必須被遮掉');
  });

  it('UUID v4 格式 → "前4...後4 (len=N)"', async () => {
    const { maskApiKey } = await import('../src/middleware/auth.js');
    const uuid = 'eb801d3f-03a3-4592-aee7-a54eb86fe0dc';
    const out = maskApiKey(uuid);
    assert.match(out, /^eb80/, 'mask 應以前 4 char 開頭');
    assert.match(out, /e0dc/, 'mask 應含後 4 char');
    assert.match(out, /len=36/, 'mask 應帶長度');
    assert.ok(!out.includes('1d3f-03a3-4592-aee7-a54eb86f'),
      'mask 不能包含 key 中段（防 PII / key 洩漏）');
  });
});

describe('v1.17.68 — auth middleware 401 path logger.warn 形狀', () => {
  it('401 時 logger.warn("auth_failed", {...}) 必須帶 route + masked_key + ip + ua', async () => {
    const auth = (await import('../src/middleware/auth.js')).default;

    // 收集 logger.warn 呼叫
    const warnCalls = [];
    const fakeLogger = {
      warn: (msg, meta) => warnCalls.push({ msg, meta }),
      error: () => {},
    };

    // 收集 query 呼叫，回 0 row 模擬 key 不存在
    const fakeQuery = async () => ({ rows: [] });

    // 注入：auth.js 必須支援 testHooks 注入 logger + query
    // （不接受全域 module mock 是因為 node:test 沒有 jest 那種能力）
    const req = {
      headers: {
        authorization: 'Bearer --update',
        'user-agent': 'OwnMindScanner/1.17.66 node/v22.0.0',
      },
      path: '/api/usage/events',
      ip: '203.0.113.45',
    };
    let statusCode = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json() { return this; },
    };
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    await auth(req, res, next, { logger: fakeLogger, query: fakeQuery });

    assert.equal(statusCode, 401, '應該 401');
    assert.equal(nextCalled, false, 'next() 不該被呼叫');
    assert.equal(warnCalls.length, 1, '應該呼叫 logger.warn 恰好 1 次');
    assert.equal(warnCalls[0].msg, 'auth_failed');
    const meta = warnCalls[0].meta;
    assert.equal(meta.route, '/api/usage/events');
    assert.equal(meta.ip, '203.0.113.45');
    // v1.17.68 reviewer 抓到：8 char key 不能走 prefix...suffix（會直接拼回原文），
    // 改走 <too-short:8> 路徑。
    assert.equal(meta.masked_key, '<too-short:8>');
    assert.ok(!meta.masked_key.includes('update'), '不能含原 key 任何 substring');
    assert.match(meta.ua, /OwnMindScanner/);
  });

  it('「未提供認證令牌」path 也要 log（沒 Bearer header）', async () => {
    const auth = (await import('../src/middleware/auth.js')).default;
    const warnCalls = [];
    const fakeLogger = { warn: (m, meta) => warnCalls.push({ m, meta }), error: () => {} };
    const req = { headers: {}, path: '/api/memory/init', ip: '203.0.113.46' };
    let statusCode = null;
    const res = { status(c) { statusCode = c; return this; }, json() { return this; } };
    await auth(req, res, () => {}, { logger: fakeLogger, query: async () => ({ rows: [] }) });
    assert.equal(statusCode, 401);
    assert.equal(warnCalls.length, 1, '沒帶 Bearer 也要 log（這也是 401 的一種）');
    assert.equal(warnCalls[0].meta.masked_key, '<no-bearer>');
  });
});
