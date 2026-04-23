import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpSource = readFileSync(join(__dirname, '..', 'mcp', 'index.js'), 'utf8');

// Prevent crash-loop heartbeat spam: each MCP process must fire at most one
// heartbeat regardless of how many times sendMcpHeartbeat() is called.
// Verify both the module-scope flag and the early-return guard exist.

test('sendMcpHeartbeat has module-scope flag to prevent repeat sends', () => {
  // Expect a module-level declaration like `let heartbeatSent = false;`
  // (or `var`; not `const` because we flip it to true).
  const flagPattern = /^(?:let|var)\s+heartbeatSent\s*=\s*false\s*;?\s*$/m;
  assert.ok(
    flagPattern.test(mcpSource),
    'expected a module-scope `let heartbeatSent = false;` flag guarding sendMcpHeartbeat from repeat sends (crash-loop protection)'
  );
});

test('sendMcpHeartbeat early-returns when heartbeatSent is already true', () => {
  // Locate the function body
  const fnStart = mcpSource.indexOf('async function sendMcpHeartbeat()');
  assert.ok(fnStart > 0, 'expected `async function sendMcpHeartbeat()` declaration');
  // Grab a reasonable slice (first 400 chars of the function body)
  const body = mcpSource.slice(fnStart, fnStart + 400);
  // Expect the first statement inside the function to short-circuit when flag is true
  // AND to set it to true before the await (so a second call during the in-flight
  // POST also short-circuits — synchronous set of the flag is critical).
  assert.match(
    body,
    /if\s*\(\s*heartbeatSent\s*\)\s*return\s*;?/,
    'expected `if (heartbeatSent) return;` as the early-return guard at the top of sendMcpHeartbeat'
  );
  assert.match(
    body,
    /heartbeatSent\s*=\s*true\s*;?/,
    'expected `heartbeatSent = true;` to be set BEFORE the await, so parallel calls also short-circuit before the first POST resolves'
  );

  // Sanity: ensure the flag set comes before the `await callApi(` call (synchronous
  // set before the await is what actually blocks parallel re-entry).
  const setIdx = body.search(/heartbeatSent\s*=\s*true/);
  const awaitIdx = body.search(/await\s+callApi\s*\(/);
  assert.ok(setIdx >= 0 && awaitIdx >= 0, 'expected both flag set and await callApi in function body');
  assert.ok(
    setIdx < awaitIdx,
    'flag must be set BEFORE await callApi so parallel/rapid calls all short-circuit during the in-flight POST'
  );
});
