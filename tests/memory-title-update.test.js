import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.26.29 — memory title editing via ownmind_update
 *
 * mcp/index.js auto-connects to the stdio MCP server on load and cannot be
 * imported in tests, and the PUT route needs a live DB — so this follows the
 * source-level verification precedent set by iron-rule-tier-mcp.test.js:
 * read the file + assert the wiring exists. It safeguards against a refactor
 * accidentally dropping the title path again (which is exactly how the
 * capability was missing in the first place: the server supported title
 * updates all along, the MCP schema just never exposed it).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'mcp', 'index.js'), 'utf8');
const MEMORY_ROUTE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'memory.js'), 'utf8');

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

describe('v1.26.29 — ownmind_update title field (MCP client)', () => {
  it('inputSchema declares an optional title field', () => {
    const block = extractToolBlock('ownmind_update');
    assert.match(block, /title:\s*\{\s*type:\s*"string"/);
  });

  it('title is NOT in the required list (update stays partial)', () => {
    const block = extractToolBlock('ownmind_update');
    const requiredMatch = block.match(/required:\s*\[([^\]]*)\]/);
    assert.ok(requiredMatch, 'required list not found');
    assert.ok(!requiredMatch[1].includes('"title"'),
      'title must stay optional on update');
  });

  it('case handler forwards args.title to body.title (only when provided)', () => {
    const block = extractCaseBlock('ownmind_update');
    assert.match(block,
      /if \(args\.title !== undefined\) body\.title = args\.title;/);
  });
});

describe('v1.26.29 — PUT /api/memory/:id title hardening (server)', () => {
  // Slice the PUT handler out of the route file so the assertions below
  // cannot accidentally match the POST handler.
  const putStart = MEMORY_ROUTE_SOURCE.indexOf("router.put('/:id',");
  assert.ok(putStart > 0);
  const putEnd = MEMORY_ROUTE_SOURCE.indexOf("router.put('/:id/disable'");
  const PUT_BLOCK = MEMORY_ROUTE_SOURCE.slice(putStart, putEnd);

  it('rejects a present-but-empty or non-string title with 400 before any write', () => {
    // title: "" would otherwise lint an empty title and log a history change
    // while COALESCE silently keeps the old title — an inconsistent no-op.
    // A non-string (number/object) would throw at .trim() → 500 instead of 400.
    assert.match(PUT_BLOCK, /title must be a non-empty string/);
    assert.match(PUT_BLOCK, /typeof rawTitle !== 'string'/);
    assert.match(PUT_BLOCK, /rawTitle\.trim\(\) === ''/);
  });

  it('normalizes the title with trim() so "Foo " is not a phantom rename', () => {
    assert.match(PUT_BLOCK,
      /const title = typeof rawTitle === 'string' \? rawTitle\.trim\(\) : undefined;/);
  });

  it('blocks renaming a real memory INTO the __upgrade_test__ prefix', () => {
    // The prefix disarms the iron-rule lint and the secret guard; now that
    // clients can send titles, rename-to must be rejected (rename-away was
    // already handled by the v1.18.0 B2 merged-title check).
    assert.match(PUT_BLOCK, /title\.startsWith\('__upgrade_test__'\)/);
    assert.match(PUT_BLOCK, /!String\(oldMemory\.title\)\.startsWith\('__upgrade_test__'\)/);
    assert.match(PUT_BLOCK, /reserved __upgrade_test__ prefix/);
  });

  it('runs the secret guard on title-only changes too (title is keyword haystack)', () => {
    assert.match(PUT_BLOCK, /if \(\(contentChanged \|\| titleChanged\) &&/);
  });

  it('records title_change { from, to } in history metadata, gated on titleChanged', () => {
    // The gate matters: without it a no-op resend (title === oldMemory.title)
    // would log a phantom rename on every update.
    assert.match(PUT_BLOCK,
      /\.\.\.\(titleChanged && \{\s*[\s\S]{0,240}?title_change:\s*\{\s*from:\s*oldMemory\.title,\s*to:\s*title\s*\}/);
  });
});
