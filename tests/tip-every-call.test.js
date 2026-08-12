import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpSource = readFileSync(join(__dirname, '..', 'mcp', 'index.js'), 'utf8');

// v1.17.7: Tip must show on every MCP tool call, not every 10th.
//
// Previous behavior (v1.17.x before): `if (++tipCallCount % 10 === 1)` — tip
// appeared on call 1, 11, 21, ... Inconsistent with skill doc that claims
// "每次操作後附上一行". This test asserts the gating modulo is gone.

test('tip gating modulo (% 10) is removed — tip fires on every call', () => {
  // Must not contain the old every-10 gating pattern.
  const hasDecileGating = /tipCallCount\s*%\s*10/.test(mcpSource);
  assert.equal(
    hasDecileGating,
    false,
    'expected `tipCallCount % 10` gating to be removed so tips fire on every MCP tool call'
  );
});

test('random tip is included in every tool response (unconditional)', () => {
  // Since v1.17.69 we use composeToolResponse({ ..., tip: getRandomTip(), tipTag: ... })
  // instead of the original contentParts.push. Main motivation: merge multiple text parts into
  // a single part, so the Claude Code UI's collapsing cards don't hide the later parts.
  // The tip must still be attached unconditionally.
  const composeCallMatch = mcpSource.match(
    /return\s+composeToolResponse\(\s*\{[\s\S]*?\}\s*\)\s*;/
  );
  assert.ok(composeCallMatch, '預期 success path return composeToolResponse({...})');

  const composeCall = composeCallMatch[0];
  // v1.26.148 takes an argument (the account's own invocable standards), so the call is no
  // longer argument-free. What must not change is that it is called unconditionally — no
  // ternary, no `&&`, no counter — so the pattern pins the call and forbids a guard.
  assert.match(
    composeCall,
    /tip:\s*getRandomTip\((\{[^}]*\})?\)\s*,/,
    '預期 composeToolResponse 帶 tip: getRandomTip(...)，未來再有人改路徑要保持 tip 無條件帶上'
  );
  assert.doesNotMatch(
    composeCall,
    /tip:\s*[^,]*[?&|]{1,2}\s*getRandomTip/,
    'tip 不可以被條件包起來——它必須每一次呼叫都帶上'
  );
  assert.match(
    composeCall,
    /tipTag:\s*formatTag\(['"`]Tip['"`]\)/,
    '預期 tipTag 用 formatTag("Tip")，跟版號標籤對齊'
  );

  // Likewise, must not regress back to the % 10 kind of gating
  const blockStart = mcpSource.indexOf(composeCall);
  const precedingSlice = mcpSource.slice(Math.max(0, blockStart - 400), blockStart);
  const hasGuard = /if\s*\([^)]*%[^)]*\)/.test(precedingSlice.split('\n').slice(-10).join('\n'));
  assert.equal(hasGuard, false,
    'tip 不能被任何取餘條件包住 — 每次 call 都要附');
});
