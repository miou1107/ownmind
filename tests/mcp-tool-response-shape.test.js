import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * v1.17.69 — MCP tool response must be a single text part.
 *
 * Background: v1.17.0 ~ v1.17.68 mcp/index.js composed the response as four independent
 * `{ type: "text", text: ... }` parts (broadcast / header line / JSON body / tip).
 * Most MCP clients (Codex / Cursor / Antigravity) concatenate every part in order,
 * but Claude Code's UI renders tool results inside one collapsed card — the visual
 * separators between text parts get swallowed and the last part (tip) becomes hidden.
 *
 * Vin reported "the tip that used to show up is missing in Claude Code, but every other
 * tool still shows it" — that's this bug.
 *
 * Fix: merge broadcast / header / body / tip into a single text part so every client
 * renders identically.
 */

import { composeToolResponse } from '../mcp/lib/compose-tool-response.js';

describe('v1.17.69 — composeToolResponse must return a single text part', () => {
  it('module must export composeToolResponse', () => {
    assert.equal(typeof composeToolResponse, 'function');
  });

  it('return shape: { content: [{ type: "text", text: "..." }] } (exactly 1 part)', () => {
    const r = composeToolResponse({
      tag: '【OwnMind v1.17.69】記憶搜尋',
      body: '{"data":[]}',
      tip: '你可以搜尋記憶，例如「跟部署有關的鐵律」',
    });
    assert.ok(Array.isArray(r.content), 'content must be an array');
    assert.equal(r.content.length, 1,
      'starting v1.17.69, content must be a single part (so Claude Code does not hide trailing parts)');
    assert.equal(r.content[0].type, 'text');
    assert.equal(typeof r.content[0].text, 'string');
  });

  it('content contains three sections — tag + body + tip — separated by newlines', () => {
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

  it('no broadcast supplied → no extra leading blank', () => {
    const r = composeToolResponse({
      tag: 'X',
      body: 'Y',
      tip: 'Z',
    });
    const text = r.content[0].text;
    assert.ok(!text.startsWith('\n'), 'must not start with a blank line');
    assert.ok(!text.startsWith(' '), 'must not start with whitespace');
  });

  it('with broadcast, it is still merged into a single part', () => {
    const r = composeToolResponse({
      broadcastText: '📢 OwnMind broadcast\n[INFO] Upgraded to v1.22.0\n---',
      tag: '[OwnMind v1.22.0] Memory search',
      body: '{}',
      tip: 'tip text',
    });
    assert.equal(r.content.length, 1, 'broadcast must also fold into the same part');
    const text = r.content[0].text;
    assert.match(text, /📢 OwnMind broadcast/);
    assert.match(text, /Memory search/);
    assert.match(text, /Tip: tip text/);
  });

  it('tag is followed by ":\\n" before the body — multi-line JSON does not get smushed together', () => {
    const r = composeToolResponse({
      tag: '[OwnMind v1.22.0] Memory search',
      body: '{"data":[]}',
      tip: 'x',
    });
    const text = r.content[0].text;
    // tag acts as the header line: "Memory search:\n{" (body starts on the next line)
    assert.match(text, /Memory search:\n\{/);
  });

  it('blank line between body and tip (visual separator)', () => {
    const r = composeToolResponse({
      tag: '[OwnMind v1.22.0] Memory search',
      body: '{"data":[]}',
      tip: 'tip text',
      tipTag: '[OwnMind v1.22.0] Tip',
    });
    const text = r.content[0].text;
    // there must be a \n\n (one blank line) between body and tip
    assert.match(text, /\}\n\n\[OwnMind/);
  });

  it('empty tip string must not blow up', () => {
    const r = composeToolResponse({
      tag: 'A',
      body: 'B',
      tip: '',
    });
    assert.equal(r.content.length, 1);
    assert.match(r.content[0].text, /A:\nB/);
  });
});
