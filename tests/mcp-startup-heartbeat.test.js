import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpSource = readFileSync(join(__dirname, '..', 'mcp', 'index.js'), 'utf8');

test('MCP server fires sendMcpHeartbeat() at startup (before transport connect)', () => {
  const connectIdx = mcpSource.indexOf('await server.connect(transport)');
  assert.ok(connectIdx > 0, 'expected await server.connect(transport) in mcp/index.js');

  const beforeConnect = mcpSource.slice(0, connectIdx);
  const lines = beforeConnect.split('\n');
  const startupCall = lines.find(
    line => /^sendMcpHeartbeat\(\);?\s*(\/\/.*)?$/.test(line)
  );
  assert.ok(
    startupCall,
    'expected a top-level `sendMcpHeartbeat();` call before `await server.connect(transport)` so every MCP startup reports a heartbeat'
  );
});
