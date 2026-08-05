// v1.26.67 — the MCP answered "which tool is hosting me" in three places with two
// different rules, and the one used for the heartbeat was the wrong one.
//
//   mcp/index.js:258      OWNMIND_TOOL -> OWNMIND_CLIENT_TOOL -> claude-code
//   mcp/ownmind-log.js:11 OWNMIND_TOOL -> OWNMIND_CLIENT_TOOL -> claude-code
//   mcp/index.js:176                      OWNMIND_CLIENT_TOOL -> claude-code   <-- drops it
//
// `install.sh` writes OWNMIND_TOOL='cursor' into the Cursor MCP config (lines 577, 594).
// Nothing in this repository sets OWNMIND_CLIENT_TOOL, despite the comment at
// mcp/index.js:174 telling users to. So the variable the installer actually writes was
// the one the heartbeat ignored.
//
// collector_heartbeat is UNIQUE (user_id, tool). A Cursor MCP heartbeat labelled
// claude-code lands on top of the row the claude-code scanner maintains and replaces its
// machine, version and os. Two tools on one machine collapse into one row that reports
// whichever wrote last.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';

const { resolveClientTool } = await import('../shared/helpers.js');

describe('resolveClientTool', () => {
  it('prefers the variable the installer actually writes', () => {
    assert.equal(resolveClientTool({ OWNMIND_TOOL: 'cursor' }), 'cursor');
  });

  it('honours the variable the comment tells users to set', () => {
    assert.equal(resolveClientTool({ OWNMIND_CLIENT_TOOL: 'antigravity' }), 'antigravity');
  });

  it('keeps the precedence the two correct copies already had', () => {
    assert.equal(
      resolveClientTool({ OWNMIND_TOOL: 'cursor', OWNMIND_CLIENT_TOOL: 'windsurf' }),
      'cursor',
    );
  });

  it('falls back to claude-code when neither is set', () => {
    // An ordinary Claude Code install sets neither. This must not change, or every
    // existing user's history splits across two tool labels.
    assert.equal(resolveClientTool({}), 'claude-code');
  });

  it('treats an empty value as unset', () => {
    // An empty string reaching collector_heartbeat.tool creates a row no report groups
    // by and no human recognises.
    assert.equal(resolveClientTool({ OWNMIND_TOOL: '' }), 'claude-code');
    assert.equal(resolveClientTool({ OWNMIND_TOOL: '', OWNMIND_CLIENT_TOOL: 'cursor' }), 'cursor');
  });

  it('reads process.env when called with no argument', () => {
    assert.equal(typeof resolveClientTool(), 'string');
  });
});

describe('the rule lives in exactly one place', () => {
  // The defect was three copies drifting, not one wrong expression. Removing the wrong
  // copy without preventing the next one leaves the same hole open.
  const sites = ['../mcp/index.js', '../mcp/ownmind-log.js'];

  for (const site of sites) {
    it(`${site} does not re-implement the rule`, async () => {
      const src = await fs.readFile(new URL(site, import.meta.url), 'utf8');
      assert.doesNotMatch(src, /process\.env\.OWNMIND_CLIENT_TOOL/,
        'read the resolved value from shared/helpers.js instead');
      assert.doesNotMatch(src, /process\.env\.OWNMIND_TOOL/,
        'read the resolved value from shared/helpers.js instead');
      assert.match(src, /resolveClientTool/,
        'the site should be using the shared resolver');
    });
  }

  it('no longer claims an alignment that was not true', async () => {
    // The old comment read "Aligned with the CLIENT_TOOL design at mcp/index.js:167"
    // while CLIENT_TOOL was missing OWNMIND_TOOL. A comment asserting a property the
    // code lacks is what let this survive review; the shared import makes it true by
    // construction instead of by assertion.
    //
    // The first version of this assertion used /Aligned with the CLIENT_TOOL design/
    // against the raw file and passed while the file still said it, because the comment
    // wraps between "the" and "CLIENT_TOOL". Collapsing whitespace alone was still not
    // enough: the next line's own "//" sits in the gap. Strip the comment markers, then
    // the whitespace.
    const src = await fs.readFile(new URL('../mcp/ownmind-log.js', import.meta.url), 'utf8');
    const flat = src.replace(/^[ \t]*\/\/[ \t]?/gm, '').replace(/\s+/g, ' ');
    assert.match(flat, /v1\.18\.4/, 'sanity: the flattening must not have eaten the comments');
    assert.doesNotMatch(flat, /Aligned with the CLIENT_TOOL design/);
  });
});
