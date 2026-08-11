import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSessionContext } from '../hooks/lib/render-session-context.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * v1.26.141 — the session context pushed a list and never told the AI to pull.
 *
 * Measured 2026-08-11 with two independent assistants, each given only what a colleague's
 * machine gets at session start and no locally installed skill for the task. The user said
 * 「幫我做一個網頁，上面只寫 hi，然後發 pages」.
 *
 * Both recognised the standard by its title and both went to fetch it. Both then reached for
 * the one instruction the context gives — `ownmind_get("standard_detail")` — and both flagged
 * it as suspicious on their own ("that does not look like a real id"). They were right:
 *
 *     ownmind_get({ type: 'standard_detail', parent_id: 869 })  ->  { "data": [] }
 *
 * A standard whose text lives on its own record has no `standard_detail` fragments, so the
 * documented lookup returns nothing for exactly the standard the user was asking about. What
 * does work is `ownmind_search("發 pages")`, which returns it as the first row.
 *
 * The second half is the one Vin named: the context lists titles and gives two ways to fetch
 * a thing you already know the name of, and never once mentions searching. So a term that
 * matches a title by wording gets looked up, and the same thing said differently — 「公司
 * pages」, 「那個發網頁的東西」 — does not. That reads as an AI which forgot OwnMind exists.
 * Nothing had asked it to look.
 */

const withStandards = (extra = {}) => renderSessionContext(
  {
    server_version: '1.26.141',
    team_standards_digest: '[團隊] 發布網頁到 pages.fontrip.com\n[團隊] 開工先同步遠端',
    iron_rules_digest: 'IR-001: something',
    ...extra,
  },
  [],
  { tip: () => 'a tip' }
);

describe('the session context tells the AI how to read a standard it has only seen the title of', () => {
  it('does not send it to a lookup that returns nothing for these standards', () => {
    const out = withStandards();
    assert.doesNotMatch(
      out,
      /ownmind_get\(["']standard_detail["']\)/,
      'a standard whose text is on its own record has no standard_detail fragments; '
      + 'this call returns [] for precisely the standard the user asked about'
    );
  });

  /**
   * Scoped to the standards block. Asserting on the whole document would pass on the standing
   * search instructions further down, which are a different rule — mutation-checked: reverting
   * this line alone must turn this red.
   */
  const standardsBlock = (out) => {
    const start = out.indexOf('## Team standards');
    assert.ok(start > -1, 'the team standards block should be rendered');
    const end = out.indexOf('\n\n', start);
    return out.slice(start, end === -1 ? undefined : end);
  };

  it('names search, which is what actually finds one by its title', () => {
    assert.match(standardsBlock(withStandards()), /ownmind_search/);
  });

  it('says to read the standard before following it, not after', () => {
    assert.match(
      standardsBlock(withStandards()),
      /before you follow it/i,
      'the instruction belongs with the list it applies to, and has to say when to use it'
    );
  });

  it('is absent when the account has no team standards — nothing to look up', () => {
    const out = renderSessionContext(
      { server_version: '1.26.141', iron_rules_digest: 'IR-001: something' },
      [],
      { tip: () => 'a tip' }
    );
    assert.doesNotMatch(out, /## Team standards/);
  });
});

describe('the session context tells the AI when to look something up at all', () => {
  /**
   * The lists are titles. A colleague saying 「公司 pages」 is describing something that is in
   * memory under a different wording, and until this line existed nothing connected the two.
   */
  it('instructs a search when the request points at the user rather than the world', () => {
    const out = withStandards();
    assert.match(
      out,
      /points at them rather than at the world/i,
      'the trigger is the referent, not the vocabulary: every word of 「公司 pages」 is familiar'
    );
    assert.match(out, /ownmind_search/);
  });

  it('says the lists are titles only, so absence from them proves nothing', () => {
    const out = withStandards();
    assert.match(out, /titles/i);
  });

  /**
   * It has to survive the case it exists for: an account with no standards at all still has
   * memories, and a term the AI does not recognise is still worth a search.
   */
  it('is present even for an account with no team standards', () => {
    const out = renderSessionContext(
      { server_version: '1.26.141', iron_rules_digest: 'IR-001: something' },
      [],
      { tip: () => 'a tip' }
    );
    assert.match(out, /ownmind_search/);
  });

  /**
   * Reported 2026-08-11: kkvin.com's access details had been in memory for weeks and the AI
   * still answered 「我沒有 kkvin.com 的資訊」, then found them the moment it was told to look.
   *
   * The context lists profile, iron rules, standard titles and principle titles — and no
   * project memories at all, which is where that server lives. So the AI had no signal that
   * anything existed, and "I do not have that" looked true from where it sat. It is not a
   * statement about the world; it is a claim about the user's memory, and it takes a search.
   */
  it('forbids claiming ignorance of the user\'s own things before searching', () => {
    const out = withStandards();
    assert.match(out, /Never tell the user you have no information/i);
    assert.match(out, /ownmind_search/);
  });

  it('names the kinds of thing that claim applies to, not just "stuff"', () => {
    const out = withStandards();
    const idx = out.indexOf('Never tell the user you have no information');
    assert.ok(idx > -1);
    const sentence = out.slice(idx, idx + 320);
    for (const kind of ['server', 'project', 'credential', 'decision']) {
      assert.match(sentence, new RegExp(kind, 'i'), `should name ${kind}`);
    }
  });

  it('does not fire on every sentence — it is scoped to terms the AI does not recognise', () => {
    const out = withStandards();
    assert.doesNotMatch(
      out,
      /search .{0,20}(every|all) (message|question|request)/i,
      'a search on every turn is noise, and noise is the thing that gets ignored'
    );
  });
});

/**
 * IR-022: an OwnMind change has to be checked at both ends.
 *
 * The SessionStart hook is how Claude Code loads memory. Every other tool — Codex, Cursor,
 * Antigravity, OpenCode — calls `ownmind_init` and reads `instructions` (INSTRUCTIONS_SOP)
 * instead, and that path never sees the lines above. Fixing only the hook would have fixed
 * this for one tool out of five, which is the shape of the v1.26.128 bug: sent by the server,
 * dropped by one renderer, and silent about it.
 */
describe('the same guidance reaches the tools that do not use the SessionStart hook', () => {
  const sop = readFileSync(join(repoRoot, 'src/routes/memory.js'), 'utf8');
  const manual = sop.slice(sop.indexOf('const INSTRUCTIONS_SOP'), sop.indexOf('## When to Save Memory'));

  it('tells them to search on an unrecognised internal term', () => {
    assert.match(manual, /ownmind_search/);
    assert.match(manual, /do not recognise/i);
  });

  it('forbids claiming ignorance of the user\'s own things before searching', () => {
    assert.match(manual, /Never say you have no information/i);
  });

  it('steers them off the lookup that returns nothing', () => {
    assert.match(manual, /standard_detail/);
    assert.match(manual, /empty list|returns \[\]/i);
  });
});

/**
 * Review round. The first version of this change put the guidance in `INSTRUCTIONS_SOP` and
 * claimed that reached Codex, Cursor, Antigravity and OpenCode. It does not:
 *
 *     src/routes/memory.js   ...(!compact && { instructions: INSTRUCTIONS_SOP })
 *     mcp/index.js:769       GET /api/memory/init?client_version=…&compact=true
 *
 * Every caller in the repo asks for compact, `ownmind_init` included, so the field is
 * stripped before it leaves the server. The fix had been placed in the one part of the
 * payload nobody receives — which is the v1.26.128 shape it was written to avoid.
 *
 * What every tool does see on every turn is the tool list, and what every install has on
 * disk is its config template. Those are the surfaces this now uses; the SOP section stays
 * for the non-compact path, but nothing depends on it.
 */
describe('the guidance reaches surfaces that survive compact=true', () => {
  const mcp = readFileSync(join(repoRoot, 'mcp/index.js'), 'utf8');

  it('ownmind_search says when to call it, not only what it returns', () => {
    const desc = mcp.slice(mcp.indexOf('name: "ownmind_search"'), mcp.indexOf('name: "ownmind_save"'));
    assert.match(desc, /points at the user rather than at the world/i, 'the read trigger');
    assert.match(desc, /before you ask the user/i);
    assert.match(desc, /never tell the user you have no information/i);
    assert.match(desc, /before ownmind_update/i, 'reading in full before updating belongs here too');
  });

  it('ownmind_get no longer sends the AI to standard_detail for a listed standard', () => {
    // Comment lines stripped: the sentence being forbidden is quoted in the comment that
    // explains why it went, and matching that would be the test reading its own homework.
    const block = mcp
      .slice(mcp.indexOf('name: "ownmind_get"'), mcp.indexOf('name: "ownmind_search"'))
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(
      block,
      /Use standard_detail to pull the full text/,
      'this call returns an empty list for a standard whose text is on its own record'
    );
    assert.match(block, /ownmind_search/);
  });

  /**
   * The rules themselves live in one file and are injected into the user's own instruction
   * files as a marked block. They are deliberately NOT duplicated into `configs/*.md`: those
   * are templates, and a copy in each of them is a copy that drifts.
   */
  it('the block source carries all three rules', () => {
    const block = readFileSync(join(repoRoot, 'configs/ownmind-rules-block.md'), 'utf8');
    assert.match(block, /points at them, not at the world/i, 'the read trigger');
    assert.match(block, /Before you ask the user/i);
    assert.match(block, /Before you say "I don't know"/i);
    assert.match(block, /ownmind_save/, 'the write rule');
    assert.match(block, /ownmind_update/, 'the correct rule');
    assert.match(block, /ownmind_disable/, 'a memory whose premise is gone is disabled, not rewritten');
    assert.match(block, /in full/i, 'read it in full before updating — search returns a 400-char preview');
  });

  it('the block does not authorise editing shared or personal-authored memories', () => {
    const block = readFileSync(join(repoRoot, 'configs/ownmind-rules-block.md'), 'utf8');
    assert.match(block, /team_standard/);
    assert.match(block, /iron_rule/);
    assert.match(block, /let them decide|tell the user/i);
  });

  /** Fresh install and upgrade, on both platforms — four scripts, one implementation. */
  for (const f of ['install.sh', 'install.ps1', 'scripts/update.sh', 'scripts/update.ps1']) {
    it(`${f} syncs the block through the shared helper`, () => {
      const t = readFileSync(join(repoRoot, f), 'utf8');
      assert.match(t, /sync-rules-block\.cjs/, `${f}: does not call the helper`);
      assert.match(t, /ownmind-rules-block\.md/, `${f}: does not name the block source`);
    });
  }

  /**
   * The check that froze every machine's copy on its install date. `install.sh` still has one
   * of these for `GEMINI.md` — a different template, not converted here — so this is scoped to
   * CLAUDE.md rather than to the phrase. Gemini users still get the rules: the upgrade path
   * writes the block into `GEMINI.md` like every other tool's file.
   */
  it('install no longer skips CLAUDE.md just because the word OwnMind appears in it', () => {
    for (const f of ['install.sh', 'install.ps1']) {
      const t = readFileSync(join(repoRoot, f), 'utf8');
      assert.doesNotMatch(
        t,
        /CLAUDE\.md already references OwnMind, skipping/,
        `${f}: that check froze every machine's copy on its install date`
      );
    }
  });
});

/**
 * The defect this release fixes was an instruction naming a call that does not resolve. An
 * instruction naming a tool that does not exist is the same defect one layer over, and the
 * string assertions above would not catch it — `/ownmind_search/` matches
 * `ownmind_search_standards` just as happily.
 */
describe('every ownmind_* tool named in the guidance actually exists', () => {
  const mcp = readFileSync(join(repoRoot, 'mcp/index.js'), 'utf8');
  const declared = new Set([...mcp.matchAll(/name: "(ownmind_\w+)"/g)].map((m) => m[1]));

  const surfaces = {
    'hooks/lib/render-session-context.js': null,
    'src/routes/memory.js': null,
    'configs/CLAUDE.md': null,
    'configs/AGENTS.md': null,
  };

  it('the tool list itself is non-empty — otherwise this suite proves nothing', () => {
    assert.ok(declared.size > 10, `only found ${declared.size} tools`);
  });

  for (const file of Object.keys(surfaces)) {
    it(`${file} names only tools that exist`, () => {
      const text = readFileSync(join(repoRoot, file), 'utf8');
      const named = new Set([...text.matchAll(/\bownmind_[a-z_]+/g)].map((m) => m[0]));
      const unknown = [...named].filter((n) => !declared.has(n));
      assert.deepEqual(unknown, [], `not real tools: ${unknown.join(', ')}`);
    });
  }
});
