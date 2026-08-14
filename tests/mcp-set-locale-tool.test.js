import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Task 5 (gate-message-i18n) — `ownmind_set_locale` MCP tool.
 *
 * mcp/index.js auto-connects to the stdio MCP server on load (`await server.connect(transport)`
 * at the bottom of the file) and cannot be imported in tests — the same constraint
 * memory-title-update.test.js and iron-rule-tier-mcp.test.js document. This follows their
 * precedent: read the file and assert the wiring exists at the source level.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'mcp', 'index.js'), 'utf8');

function extractToolBlock(toolName) {
  const startIdx = MCP_SOURCE.indexOf(`name: "${toolName}"`);
  assert.ok(startIdx > 0, `tool "${toolName}" definition not found`);
  const rest = MCP_SOURCE.slice(startIdx);
  const nextNameIdx = rest.indexOf('\n    name: "', 5);
  const nextEndIdx = rest.indexOf('\n];');
  const endIdx = (nextNameIdx === -1 || (nextEndIdx !== -1 && nextEndIdx < nextNameIdx))
    ? nextEndIdx : nextNameIdx;
  return rest.slice(0, endIdx > 0 ? endIdx : rest.length);
}

function extractCaseBlock(toolName) {
  const startIdx = MCP_SOURCE.indexOf(`case "${toolName}":`);
  assert.ok(startIdx > 0, `case "${toolName}" handler not found`);
  const rest = MCP_SOURCE.slice(startIdx);
  const nextCaseIdx = rest.indexOf('\n    case "', 5);
  return rest.slice(0, nextCaseIdx > 0 ? nextCaseIdx : 3000);
}

describe('ownmind_set_locale — tool registration', () => {
  const block = extractToolBlock('ownmind_set_locale');

  it('inputSchema declares a required `locale` string field', () => {
    assert.match(block, /locale:\s*\{\s*type:\s*"string"/);
    const requiredMatch = block.match(/required:\s*\[([^\]]*)\]/);
    assert.ok(requiredMatch, 'required list not found');
    assert.match(requiredMatch[1], /"locale"/);
  });

  it('locale enum is exactly zh|en|ja|auto (no arbitrary strings accepted client-side)', () => {
    const enumMatch = block.match(/enum:\s*\[([^\]]*)\]/);
    assert.ok(enumMatch, 'enum not found on the locale field');
    const values = enumMatch[1].split(',').map((s) => s.trim().replace(/"/g, ''));
    assert.deepEqual(values.sort(), ['auto', 'en', 'ja', 'zh']);
  });

  it('description says what it does in one sentence: sets the language of OwnMind\'s own '
    + 'tool/gate messages, across the user\'s machines', () => {
    assert.match(block, /language/i);
    assert.match(block, /machines/i);
  });

  it('description states that `auto` reverts to the OS-detected language', () => {
    assert.match(block, /auto/);
    assert.match(block, /OS/);
  });

  it('description is English — no CJK characters (dev-facing tool text, track A/B split)', () => {
    const descMatch = block.match(/description:\s*"((?:[^"\\]|\\.)*)"/);
    assert.ok(descMatch, 'description string not found');
    assert.ok(!/[぀-ヿ㐀-鿿]/.test(descMatch[1]),
      'tool description must be English (no CJK)');
  });

  // Fix round 1 honesty requirement: the description must not overstate the effect as
  // uniformly instant — a machine other than the caller's own only re-inits at its next
  // SessionStart (the sync-token change makes that happen on its own, but not mid-session).
  it('description says the effect is immediate on this machine, next-session on others', () => {
    assert.match(block, /immediat/i);
    assert.match(block, /next session/i);
    assert.match(block, /this machine/i);
  });
});

describe('ownmind_set_locale — case handler', () => {
  const block = extractCaseBlock('ownmind_set_locale');

  it('forwards args.locale to the server as PUT /api/memory/locale', () => {
    assert.match(block, /callApi\(\s*"PUT"\s*,\s*"\/api\/memory\/locale"/);
    assert.match(block, /locale:\s*args\.locale/);
  });

  it('logs the call locally via logEvent', () => {
    assert.match(block, /logEvent\(/);
  });

  // Fix round 1: after the server write succeeds, this machine's own cache must be
  // refreshed immediately (not left to wait for the next SessionStart like every other
  // machine) — reusing the conditional-sync machinery via mcp/lib/local-locale-refresh.js,
  // never a hand-rolled second cache writer.
  it('refreshes this machine\'s local cache immediately via refreshLocalCacheForLocale', () => {
    assert.match(block, /refreshLocalCacheForLocale\(/);
  });

  it('the response message reflects both outcomes: refreshed now, or degraded to next-session', () => {
    assert.match(block, /immediat/i);
    assert.match(block, /next session/i);
  });
});

describe('ownmind_set_locale — imports', () => {
  it('imports refreshLocalCacheForLocale from mcp/lib/local-locale-refresh.js', () => {
    assert.match(MCP_SOURCE,
      /import\s*\{\s*refreshLocalCacheForLocale\s*\}\s*from\s*['"]\.\/lib\/local-locale-refresh\.js['"]/);
  });
});
