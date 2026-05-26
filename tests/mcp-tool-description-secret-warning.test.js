import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.19.1 — MCP tool descriptions must carry a sensitive-data warning
 *
 * Maps to openspec/changes/v1.19.1-secret-tool-routing/spec.md scenario 8.
 *
 * The AI should see "if it contains a password / token / API key, use
 * ownmind_set_secret instead" already at tools/list time, not after hitting 400.
 *
 * Verified at source level via regex (same approach as v1.19 iron-rule-tier-mcp.test.js):
 * loading mcp/index.js automatically connects to the stdio MCP server, so a direct
 * import is not possible — fall back to regex against the source.
 */

const MCP_INDEX_PATH = path.join(repoRoot, 'mcp', 'index.js');
const mcpSource = fs.readFileSync(MCP_INDEX_PATH, 'utf8');

/**
 * Pull a tool's description string from the mcp/index.js source.
 * Find the `description:` content that follows `name: "<toolName>"` (via regex).
 */
function extractToolDescription(toolName) {
  // Find the first description after name: "<toolName>" (may span lines)
  const re = new RegExp(
    `name:\\s*["']${toolName}["'][\\s\\S]*?description:\\s*((?:"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"|\`[^\`]*\`)(?:\\s*\\+\\s*(?:"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"|\`[^\`]*\`))*)`,
    'm'
  );
  const match = mcpSource.match(re);
  if (!match) return null;
  // Reduce string concatenation ("a" + "b") into a single string
  return match[1]
    .split(/\s*\+\s*/)
    .map(s => s.replace(/^["'`]|["'`]$/g, ''))
    .join('');
}

describe('v1.19.1 — ownmind_save description carries a sensitive-data warning', () => {
  const desc = extractToolDescription('ownmind_save');

  it('finds the ownmind_save description', () => {
    assert.ok(desc, 'should be able to pull ownmind_save description from mcp/index.js');
  });

  it('description mentions sensitive-data / password keywords', () => {
    assert.ok(
      /敏感資料|密碼|密鑰|token|API key|sensitive|password|credential/i.test(desc),
      `description should mention sensitive-data / password keywords; actual: "${desc}"`
    );
  });

  it('description mentions "ownmind_set_secret" (points to the right tool)', () => {
    assert.ok(
      desc.includes('ownmind_set_secret'),
      `description should explicitly mention ownmind_set_secret; actual: "${desc}"`
    );
  });

  it('warning sits near the start of the description (within the first 80 chars)', () => {
    const firstChunk = desc.slice(0, 80);
    assert.ok(
      /敏感|密碼|set_secret|ownmind_set_secret|sensitive|password|credential|secret/i.test(firstChunk),
      `warning should be within the first 80 chars; actual head: "${firstChunk}"`
    );
  });
});

describe('v1.19.1 — ownmind_update description carries a sensitive-data warning', () => {
  const desc = extractToolDescription('ownmind_update');

  it('finds the ownmind_update description', () => {
    assert.ok(desc);
  });

  it('description mentions sensitive-data / password keywords', () => {
    assert.ok(
      /敏感資料|密碼|密鑰|token|API key|sensitive|password|credential/i.test(desc),
      `description should mention sensitive data; actual: "${desc}"`
    );
  });

  it('description mentions "ownmind_set_secret"', () => {
    assert.ok(desc.includes('ownmind_set_secret'));
  });

  it('warning sits near the start of the description (within the first 80 chars)', () => {
    const firstChunk = desc.slice(0, 80);
    assert.ok(/敏感|密碼|set_secret|ownmind_set_secret|sensitive|password|credential|secret/i.test(firstChunk));
  });
});

describe('v1.19.1 — ownmind_set_secret description does not refer to itself (avoid loops)', () => {
  const desc = extractToolDescription('ownmind_set_secret');

  it('finds the ownmind_set_secret description', () => {
    assert.ok(desc);
  });

  it('description does not contain a "use ownmind_set_secret instead" loop hint', () => {
    assert.ok(
      !desc.includes('請改用 ownmind_set_secret') &&
      !/use\s+ownmind_set_secret\s+instead/i.test(desc),
      `set_secret\'s own description should not tell users to "use set_secret"; actual: "${desc}"`
    );
  });
});
