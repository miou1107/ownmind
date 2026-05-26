import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * v1.17.69 — MCP tool response 必須是單一 text part
 *
 * 背景：v1.17.0 ~ v1.17.68 mcp/index.js 把回傳組成 4 個獨立的
 * `{ type: "text", text: ... }` parts（broadcast / 前綴行 / JSON body / 技巧提示）。
 * 多數 MCP client（Codex / Cursor / Antigravity）會把全部 part 順序合起來顯示，
 * 但 Claude Code 的 UI 預設只把工具結果用一個摺疊卡片顯示，**多個 text part
 * 之間的視覺被吃掉**、最後一個 part（tip）藏起來看不到。
 *
 * Vin 回報「之前都會出現的技巧提示，現在在 Claude Code 看不到，其他工具都有」
 * 就是這個 bug。
 *
 * 修法：把 broadcast / 前綴 / body / tip 合併成一個 text part，所有 client
 * 渲染一致。
 */

import { composeToolResponse } from '../mcp/lib/compose-tool-response.js';

describe('v1.17.69 — composeToolResponse 必回單一 text part', () => {
  it('module 應 export composeToolResponse', () => {
    assert.equal(typeof composeToolResponse, 'function');
  });

  it('回傳結構：{ content: [{ type: "text", text: "..." }] }（恰好 1 個 part）', () => {
    const r = composeToolResponse({
      tag: '【OwnMind v1.17.69】記憶搜尋',
      body: '{"data":[]}',
      tip: '你可以搜尋記憶，例如「跟部署有關的鐵律」',
    });
    assert.ok(Array.isArray(r.content), 'content 必須是 array');
    assert.equal(r.content.length, 1,
      'v1.17.69 起 content 必須是單一 part（避免 Claude Code 隱藏多 part 的後段）');
    assert.equal(r.content[0].type, 'text');
    assert.equal(typeof r.content[0].text, 'string');
  });

  it('內容包含 tag + body + tip 三段、用換行分隔', () => {
    const r = composeToolResponse({
      tag: '[OwnMind v1.22.0] Memory search',
      body: '{"data":[]}',
      tip: 'You can search memories',
    });
    const text = r.content[0].text;
    assert.match(text, /Memory search/);
    assert.match(text, /\{"data":\[\]\}/);
    assert.match(text, /Tip: You can search memories/);
  });

  it('沒給 broadcast 不會多一段空白', () => {
    const r = composeToolResponse({
      tag: 'X',
      body: 'Y',
      tip: 'Z',
    });
    const text = r.content[0].text;
    assert.ok(!text.startsWith('\n'), '不該以空白行開頭');
    assert.ok(!text.startsWith(' '), '不該以空白開頭');
  });

  it('有 broadcast 時也要併進來、且仍是單一 part', () => {
    const r = composeToolResponse({
      broadcastText: '📢 OwnMind broadcast\n[INFO] Upgraded to v1.22.0\n---',
      tag: '[OwnMind v1.22.0] Memory search',
      body: '{}',
      tip: 'tip text',
    });
    assert.equal(r.content.length, 1, 'broadcast 也要併進同一個 part');
    const text = r.content[0].text;
    assert.match(text, /📢 OwnMind broadcast/);
    assert.match(text, /Memory search/);
    assert.match(text, /Tip: tip text/);
  });

  it('tag 後接「:\\n」再接 body — body 多行 JSON 不會被擠成一坨', () => {
    const r = composeToolResponse({
      tag: '[OwnMind v1.22.0] Memory search',
      body: '{"data":[]}',
      tip: 'x',
    });
    const text = r.content[0].text;
    // tag 當 header 行：「Memory search:\n{」（換行後才是 body）
    assert.match(text, /Memory search:\n\{/);
  });

  it('body 跟 tip 之間有空白行（視覺分隔）', () => {
    const r = composeToolResponse({
      tag: '[OwnMind v1.22.0] Memory search',
      body: '{"data":[]}',
      tip: 'tip text',
      tipTag: '[OwnMind v1.22.0] Tip',
    });
    const text = r.content[0].text;
    // body 跟 tip 之間應該有 \n\n（一個空白行）
    assert.match(text, /\}\n\n\[OwnMind/);
  });

  it('tip 為空字串時也不該炸', () => {
    const r = composeToolResponse({
      tag: 'A',
      body: 'B',
      tip: '',
    });
    assert.equal(r.content.length, 1);
    assert.match(r.content[0].text, /A:\nB/);
  });
});
