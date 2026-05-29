import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.19 — source-level verification of the tier field integration in mcp/index.js
 *
 * mcp/index.js auto-connects to the stdio MCP server on load and cannot be imported in tests.
 * Use source-level verification: read the file + regex-check that tier appears in the right place.
 *
 * This is only a quality safeguard: prevent someone refactoring mcp/index.js from accidentally
 * removing the tier integration. Full end-to-end coverage comes from the later phase B server
 * API integration tests.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_INDEX_PATH = path.join(__dirname, '..', 'mcp', 'index.js');
const MCP_SOURCE = fs.readFileSync(MCP_INDEX_PATH, 'utf8');

function extractToolBlock(toolName) {
  const startIdx = MCP_SOURCE.indexOf(`name: "${toolName}"`);
  assert.ok(startIdx > 0, `找不到 tool "${toolName}" 的定義`);
  // Simple slice: from this tool, scan forward to the next name: or ];
  const rest = MCP_SOURCE.slice(startIdx);
  const nextNameIdx = rest.indexOf('\n    name: "', 5);
  const nextEndIdx = rest.indexOf('\n];');
  const endIdx = (nextNameIdx === -1 || (nextEndIdx !== -1 && nextEndIdx < nextNameIdx))
    ? nextEndIdx : nextNameIdx;
  return rest.slice(0, endIdx > 0 ? endIdx : rest.length);
}

function extractCaseBlock(toolName) {
  const startIdx = MCP_SOURCE.indexOf(`case "${toolName}":`);
  assert.ok(startIdx > 0, `找不到 case "${toolName}" 的 handler`);
  const rest = MCP_SOURCE.slice(startIdx);
  // Slice up to the next case or the closing }
  const nextCaseIdx = rest.indexOf('\n    case "', 5);
  return rest.slice(0, nextCaseIdx > 0 ? nextCaseIdx : 3000);
}

describe('v1.19 — MCP tier integration', () => {
  describe('ownmind_save schema', () => {
    const saveBlock = extractToolBlock('ownmind_save');

    it('inputSchema includes the tier field', () => {
      assert.match(saveBlock, /tier:\s*\{/);
    });

    it('tier field lists three valid enum values', () => {
      assert.match(saveBlock, /tier:[\s\S]*?enum:[\s\S]*?critical/);
      assert.match(saveBlock, /tier:[\s\S]*?enum:[\s\S]*?default/);
      assert.match(saveBlock, /tier:[\s\S]*?enum:[\s\S]*?advisory/);
    });

    it('tier field has a description mentioning critical / default / advisory usage', () => {
      const tierSchema = saveBlock.slice(saveBlock.indexOf('tier:'));
      assert.match(tierSchema, /critical/);
      assert.match(tierSchema, /default/);
      assert.match(tierSchema, /advisory/);
    });
  });

  describe('ownmind_update schema', () => {
    const updateBlock = extractToolBlock('ownmind_update');

    it('inputSchema includes the tier field', () => {
      assert.match(updateBlock, /tier:\s*\{/);
    });

    it('tier field lists three valid enum values', () => {
      assert.match(updateBlock, /tier:[\s\S]*?enum:[\s\S]*?critical/);
      assert.match(updateBlock, /tier:[\s\S]*?enum:[\s\S]*?default/);
      assert.match(updateBlock, /tier:[\s\S]*?enum:[\s\S]*?advisory/);
    });
  });

  describe('ownmind_save case handler', () => {
    const saveCase = extractCaseBlock('ownmind_save');

    it('passes args.tier to body.tier (only when provided)', () => {
      assert.match(saveCase, /if\s*\(\s*args\.tier\s*!==\s*undefined\s*\)\s*body\.tier\s*=\s*args\.tier/);
    });
  });

  describe('ownmind_update case handler', () => {
    const updateCase = extractCaseBlock('ownmind_update');

    it('passes args.tier to body.tier (only when provided)', () => {
      assert.match(updateCase, /if\s*\(\s*args\.tier\s*!==\s*undefined\s*\)\s*body\.tier\s*=\s*args\.tier/);
    });
  });
});
