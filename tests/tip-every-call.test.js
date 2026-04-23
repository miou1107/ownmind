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

test('random tip is pushed into every tool response content (unconditional)', () => {
  // Locate the handleTool success return block. We expect a contentParts.push
  // for the tip that is NOT guarded by a modulo / counter condition.
  const returnBlockStart = mcpSource.indexOf('return { content: contentParts };');
  assert.ok(returnBlockStart > 0, 'expected handleTool to return { content: contentParts }');

  // Look at the 400 chars preceding the return — that's where the tip push lives.
  const precedingSlice = mcpSource.slice(Math.max(0, returnBlockStart - 400), returnBlockStart);

  // Must have the tip push ...
  assert.match(
    precedingSlice,
    /contentParts\.push\([^)]*formatTag\(['"`]技巧提示['"`]\)/,
    'expected contentParts.push(...formatTag("技巧提示")...) before the final return'
  );

  // ... and must NOT be wrapped in an `if (...% ...)` condition on the same line or immediately before.
  const lastFiftyLines = precedingSlice.split('\n').slice(-10).join('\n');
  const hasGuardedPush = /if\s*\([^)]*%[^)]*\)\s*\{?\s*(?:\/\/[^\n]*\n\s*)?contentParts\.push\([^)]*技巧提示/
    .test(lastFiftyLines);
  assert.equal(
    hasGuardedPush,
    false,
    'tip push must not be guarded by a modulo condition — it should fire on every call'
  );
});
