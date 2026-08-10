// v1.26.127 — the tips OwnMind attaches to its own responses have to be true.
//
// Every MCP tool response carries a one-line tip (since v1.17.7, unconditionally). The list
// behind it existed twice: `const TIPS` in mcp/index.js and a byte-identical bullet list
// inside INSTRUCTIONS_SOP in src/routes/memory.js, served to clients that use the API. Two
// hand-maintained copies of one list is a drift that fails silently — nothing compares them.
//
// The list had also drifted from the product. Tips shipped in front of users describing a
// way to review disabled iron rules and a self-improvement behaviour that nothing anywhere
// implements. A tip is a claim about the product, phrased in the product's own voice, and
// the user has no way to tell an unbacked one apart from the rest.
//
// So: one list, in shared/tips.js, with an anchor per tip. This file is what makes the
// anchor mean something.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIPS, renderTipPool, getRandomTip } from '../shared/tips.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

/** Templates that tell the AI to show a tip. openclaw-bootstrap.md has no tip line. */
const TIP_TEMPLATES = [
  'configs/AGENTS.md',
  'configs/GEMINI.md',
  'configs/global_rules.md',
  'configs/copilot-instructions.md',
  'configs/antigravity.md',
];

/**
 * Tool names the MCP server actually registers. Sliced to the TOOLS array rather than to end
 * of file: past its closing bracket there are other `name:` fields (the server identity at
 * the bottom, for one) and admitting those would let a tip anchor to something that is not a
 * tool at all.
 */
function mcpToolNames() {
  const src = read('mcp/index.js');
  const start = src.indexOf('const TOOLS = [');
  assert.ok(start > -1, 'mcp/index.js no longer declares `const TOOLS = [` — update this test');
  const end = src.indexOf('\n];', start);
  assert.ok(end > start, 'could not find the end of the TOOLS array');
  const names = [...src.slice(start, end).matchAll(/name:\s*"(ownmind_[a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 10, `only ${names.length} MCP tools parsed — the extraction broke`);
  return new Set(names);
}

describe('shared/tips.js — every tip is anchored to something real', () => {
  it('carries enough tips to be worth randomising over', () => {
    assert.ok(TIPS.length >= 8, `only ${TIPS.length} tips — a "random tip" needs a pool`);
  });

  it('every entry has text and an anchor', () => {
    for (const [i, tip] of TIPS.entries()) {
      assert.equal(typeof tip.text, 'string', `tip ${i} has no text`);
      assert.ok(tip.text.length >= 20, `tip ${i} is too short to be a tip: "${tip.text}"`);
      assert.equal(typeof tip.anchor, 'string', `tip "${tip.text}" has no anchor`);
      assert.ok(tip.anchor.length > 0, `tip "${tip.text}" has an empty anchor`);
    }
  });

  it('every anchor is either a registered MCP tool or a file that exists', () => {
    const tools = mcpToolNames();
    for (const { text, anchor } of TIPS) {
      if (anchor.startsWith('file:')) {
        const rel = anchor.slice('file:'.length);
        assert.ok(
          existsSync(join(repoRoot, rel)),
          `tip "${text}" is anchored to ${rel}, which does not exist`,
        );
        continue;
      }
      assert.ok(
        tools.has(anchor),
        `tip "${text}" is anchored to ${anchor}, which is not an MCP tool — either the tool `
        + 'was renamed, or the tip describes something that was never built',
      );
    }
  });

  it('no tip is written twice', () => {
    const seen = new Set();
    for (const { text } of TIPS) {
      assert.ok(!seen.has(text), `duplicate tip: "${text}"`);
      seen.add(text);
    }
  });

  it('getRandomTip returns text from the list and never repeats back to back', () => {
    const texts = new Set(TIPS.map((t) => t.text));
    let previous = null;
    for (let i = 0; i < 200; i += 1) {
      const tip = getRandomTip();
      assert.ok(texts.has(tip), `getRandomTip returned something not in the list: "${tip}"`);
      assert.notEqual(tip, previous, 'the same tip came back twice in a row');
      previous = tip;
    }
  });
});

describe('one list, two consumers', () => {
  it('mcp/index.js takes the tip from the shared module', () => {
    const src = read('mcp/index.js');
    assert.match(src, /import \{[^}]*getRandomTip[^}]*\} from '\.\.\/shared\/tips\.js'/);
    assert.doesNotMatch(
      src, /^const TIPS = \[/m,
      'mcp/index.js declares its own TIPS array again — that is the copy this change removed',
    );
  });

  it('the operations manual renders the pool instead of restating it', () => {
    const src = read('src/routes/memory.js');
    assert.match(src, /import \{[^}]*renderTipPool[^}]*\} from '\.\.\/\.\.\/shared\/tips\.js'/);
    assert.match(src, /The pool that tip is drawn from[^\n]*\n\$\{renderTipPool\(\)\}/);
  });

  it('no tip text is hardcoded anywhere outside the shared module', () => {
    // The failure this catches is not a broken build: it is a second copy that agrees today
    // and disagrees after the next edit, which is exactly the state this change found.
    //
    // Swept across every tracked file rather than the two that happened to hold the copies.
    // Scoping the sweep to known offenders is how the pair arose: the first copy was not a
    // known offender either. Only shared/tips.js and the release notes explaining the change
    // are exempt.
    const EXEMPT = /^(shared\/tips\.js|CHANGELOG\.md|FILELIST\.md|openspec\/)/;
    const tracked = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter((p) => p && !EXEMPT.test(p));
    assert.ok(tracked.length > 100, `only ${tracked.length} tracked files — the sweep broke`);

    for (const path of tracked) {
      const full = join(repoRoot, path);
      let src;
      try {
        if (statSync(full).size > 3 * 1024 * 1024) continue;
        src = readFileSync(full, 'utf8');
      } catch {
        continue; // deleted since `git ls-files`, or not decodable as text
      }
      for (const { text } of TIPS) {
        assert.ok(
          !src.includes(text),
          `${path} restates the tip "${text}" — it should come from shared/tips.js`,
        );
      }
    }
  });

  it('the rendered pool is one bullet per tip', () => {
    const lines = renderTipPool().split('\n');
    assert.equal(lines.length, TIPS.length);
    for (const line of lines) assert.match(line, /^- \S/);
  });
});

describe('every path that asks for a tip supplies one', () => {
  it('the SessionStart context carries a tip from the list', async () => {
    // This is the path the invented tips came from. The startup instruction in
    // configs/AGENTS.md prints a tip right after the memory load, and loading memory through
    // the hook is not an MCP tool call — so nothing supplied one and the model improvised.
    const { renderSessionContext } = await import('../hooks/lib/render-session-context.js');
    const out = renderSessionContext({ server_version: '1.26.127' }, []);
    const line = out.split('\n').find((l) => l.startsWith('Tip ('));
    assert.ok(line, 'the SessionStart context has no tip line — the improvise gap is open again');
    assert.ok(
      TIPS.some((t) => line.includes(t.text)),
      `the SessionStart tip is not from shared/tips.js: ${line}`,
    );
  });

  it('the SessionStart tip line tells the AI not to write its own', () => {
    // Without this the line is just text the model may treat as a sample to riff on.
    const src = read('hooks/lib/render-session-context.js');
    assert.match(src, /do not compose your own/);
  });
});

describe('the templates relay the tip rather than composing one', () => {
  for (const path of TIP_TEMPLATES) {
    const src = read(path);
    // Per line, not per file: configs/AGENTS.md has two tip sites, and a file-wide check is
    // satisfied by whichever one is still correct while the other quietly reverts.
    const tipLines = src.split(/\r?\n/).filter((l) => l.includes('技巧提示'));

    it(`${path} has at least one tip instruction to check`, () => {
      assert.ok(tipLines.length > 0, `${path} is listed as a tip template but has no tip line`);
    });

    it(`${path} forbids inventing a tip, on every tip line`, () => {
      for (const line of tipLines) {
        assert.ok(
          line.includes('不可自行編造'),
          `${path} has a tip instruction that does not forbid making one up: ${line.trim()}`,
        );
      }
    });

    it(`${path} names where the tip comes from, on every tip line`, () => {
      for (const line of tipLines) {
        assert.ok(
          line.includes('沿用') && line.includes('Tip'),
          `${path} has a tip instruction that never says to reuse the one OwnMind supplied: `
          + line.trim(),
        );
      }
    });

    it(`${path} says to show nothing when no tip was supplied`, () => {
      // The gap that produced the invented tips: the instruction fired on a path that
      // supplied no tip. v1.26.127 closes that path, but "relay it" without "and if there
      // isn't one, say nothing" leaves the same hole open for the next path someone adds.
      for (const line of tipLines) {
        assert.ok(
          line.includes('沒給就不要顯示'),
          `${path} tells the AI to relay a tip but not what to do when there is none: `
          + line.trim(),
        );
      }
    });
  }
});
