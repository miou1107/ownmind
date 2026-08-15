// The handoff tool could not be called the way it says it may be called.
//
// `ownmind_handoff_create` declares `project` and `content` required and `from_tool`,
// `from_model`, `from_machine` optional. POST /api/handoff required four fields, two of
// them the optional ones. Measured against production on 2026-08-15:
//
//   project + content                  -> 400  Missing required fields: from_tool, from_model
//   project + content + from_tool      -> 400  Missing required fields: from_model
//   all four                           -> 201
//
// So every caller that trusted the schema lost its handoff, and the feature only worked by
// accident when the caller happened to send two fields it was told it could omit.
//
// This is the same defect as Eric's bug #9 (v1.26.61, session logs), one table over, and it
// takes the same decision: the columns have always been nullable (db/001_init.sql:76-87), the
// MCP process already holds the tool in a constant, and nothing anywhere knows the model.
// See tests/session-log-args.test.js for the original.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHandoffBody } from '../mcp/lib/handoff-body.js';
import { findMissingArgs } from '../mcp/lib/required-args.js';
import { TIPS } from '../shared/tips.js';

describe('buildHandoffBody — what actually goes to the server', () => {
  const clientTool = 'cursor';

  it('passes through everything the caller supplied', () => {
    const body = buildHandoffBody({
      project: 'OwnMind', content: 'where I left off',
      from_tool: 'codex', from_model: 'gpt-5', from_machine: 'box',
    }, { clientTool });
    assert.deepEqual(body, {
      project: 'OwnMind', content: 'where I left off',
      from_tool: 'codex', from_model: 'gpt-5', from_machine: 'box',
    });
  });

  it('fills from_tool from the client when the caller omitted it', () => {
    // The value the process already holds in CLIENT_TOOL and already sends as the heartbeat
    // tool and the x-ownmind-tool header. Asking the caller for it is asking to be told
    // something we know — and that ask is what returned 400.
    const body = buildHandoffBody({ project: 'p', content: 'c' }, { clientTool });
    assert.equal(body.from_tool, 'cursor');
  });

  it('does not override a from_tool the caller did supply', () => {
    const body = buildHandoffBody({ project: 'p', content: 'c', from_tool: 'opencode' }, { clientTool });
    assert.equal(body.from_tool, 'opencode');
  });

  it('treats an empty or blank from_tool as absent', () => {
    for (const empty of ['', '   ', null, undefined]) {
      const body = buildHandoffBody({ project: 'p', content: 'c', from_tool: empty }, { clientTool });
      assert.equal(body.from_tool, 'cursor', `from_tool=${JSON.stringify(empty)} should fall back`);
    }
  });

  it('leaves from_model absent rather than inventing one', () => {
    // Same reasoning as session logs: there is no signal for the model in this process, and
    // a fabricated "unknown" would land in a column the console groups by.
    const body = buildHandoffBody({ project: 'p', content: 'c' }, { clientTool });
    assert.ok(!('from_model' in body), 'from_model must not be fabricated');
  });

  it('a blank from_model or from_machine is dropped, not sent as an empty string', () => {
    const body = buildHandoffBody({
      project: 'p', content: 'c', from_model: '  ', from_machine: '',
    }, { clientTool });
    assert.ok(!('from_model' in body));
    assert.ok(!('from_machine' in body));
  });

  it('never defaults project or content', () => {
    // The two fields with no source but the caller. A handoff with no content is a row that
    // hands over nothing, and the guard must be the one to say so.
    const body = buildHandoffBody({}, { clientTool });
    assert.ok(!('project' in body));
    assert.ok(!('content' in body));
  });

  it('does not strip a whitespace-only content that the guard let through', () => {
    // The trap adversarial review caught in the session-log version: if this module were
    // stricter than the guard and the server, a blank-but-present value would pass the
    // client check, be stripped here, and come back as a generic 400 — the exact loop the
    // change exists to end.
    const body = buildHandoffBody({ project: '   ', content: '   ' }, { clientTool });
    assert.equal(body.project, '   ');
    assert.equal(body.content, '   ');
  });

  it('reproduces the failing call: the two fields the schema requires, and nothing else', () => {
    const body = buildHandoffBody({ project: 'OwnMind', content: '接手內容' }, { clientTool: 'claude-code' });
    assert.equal(body.project, 'OwnMind');
    assert.equal(body.content, '接手內容');
    assert.equal(body.from_tool, 'claude-code');
    assert.ok(!('from_model' in body));
  });
});

describe('the declared contract matches what the server enforces', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

  it('ownmind_handoff_create declares project and content as required', () => {
    const mcp = read('mcp/index.js');
    const from = mcp.indexOf('name: "ownmind_handoff_create"');
    assert.ok(from > 0, 'ownmind_handoff_create is not declared');
    const next = mcp.indexOf('name: "ownmind_', from + 10);
    const block = mcp.slice(from, next > from ? next : undefined);
    const required = block.match(/required: \[([^\]]*)\]/);
    assert.ok(required, 'ownmind_handoff_create has no required list');
    assert.equal(
      required[1].replace(/["'\s]/g, ''),
      'project,content',
      'from_tool is defaulted and from_model is optional — neither may be required',
    );
  });

  it('the server asks for no more than the client promises to send', () => {
    // This is the assertion that fails against the bug: the endpoint asked for four fields
    // while its own columns were nullable and its only client declared two.
    const route = read('src/routes/handoff.js');
    const m = route.match(/requireFields\(req\.body, \[([^\]]*)\]\)/);
    assert.ok(m, 'POST /api/handoff has no requireFields call');
    assert.equal(m[1].replace(/["'\s]/g, ''), 'project,content');
  });

  it('the handler sends the body this module builds, not one assembled inline', () => {
    // The inline version is what drifted from the schema. If it comes back, the two tests
    // above can both pass while the shipped call still omits the default.
    const mcp = read('mcp/index.js');
    const from = mcp.indexOf('case "ownmind_handoff_create"');
    assert.ok(from > 0);
    // Bounded the same way as the block above: an unguarded indexOf returns -1 if the accept
    // case is ever renamed, and slice(from, -1) then runs these assertions over most of the
    // file instead of over this handler.
    const next = mcp.indexOf('case "ownmind_handoff_accept"', from + 10);
    const block = mcp.slice(from, next > from ? next : undefined);
    assert.match(block, /buildHandoffBody\(/, 'the handler must build its body through the shared module');
    // Both access forms: `args.from_model` and `args["from_model"]` are the same inline
    // assembly, and pinning only the dot form leaves the other one a silent way back in.
    assert.doesNotMatch(block, /args\s*(\.\s*from_model|\[\s*["']from_model["']\s*\])/,
      'reading from_model straight off args is the inline assembly this replaced');
  });
});

describe('the builder never strips what the guard let through', () => {
  // Copied from tests/session-log-args.test.js, and the reason it is copied rather than
  // summarised: the invariant is a relationship between two modules, so only a test that
  // imports both can hold it. Pinned by one hand-written example instead, a later tightening
  // of isMissingValue would turn the session-log test red and leave this one green — and
  // `content: "   "` would silently regain the pass-the-guard-then-generic-400 loop that
  // handoff-body.js exists to prevent.
  const clientTool = 'claude-code';

  it('the two rules agree on every value the guard is asked about', () => {
    for (const v of ['', '   ', 'x', null, undefined]) {
      for (const field of ['project', 'content']) {
        const args = { project: 'p', content: 'c', [field]: v };
        const guardSaysMissing = findMissingArgs('ownmind_handoff_create', args, ['project', 'content']).length > 0;
        const builderDropsIt = !(field in buildHandoffBody(args, { clientTool }));
        assert.equal(
          builderDropsIt, guardSaysMissing,
          `${field}=${JSON.stringify(v)}: guard and builder must agree, or the call fails at the server`,
        );
      }
    }
  });

  it('but a blank from_tool still falls back — the guard does not enforce that one', () => {
    assert.equal(buildHandoffBody({ project: 'p', content: 'c', from_tool: '   ' }, { clientTool }).from_tool, clientTool);
  });
});

describe('nothing tells the user the model is always recorded', () => {
  // A tip is a claim about the product, in the product's own voice (shared/tips.js header).
  // Before this change the endpoint refused any handoff without a model, so "every handoff
  // records the source tool and model" was true of every row that existed. It is not true of
  // rows created from now on, and tests/tips-list.test.js only checks that a tip's anchor
  // names a registered tool — so the false claim shipped green.
  //
  // Pinned as a relationship rather than as wording: whenever buildHandoffBody can return a
  // body with no from_model, no handoff tip may mention the model without a condition.

  it('the builder is still able to produce a handoff with no model', () => {
    // The premise the assertion below depends on. If this ever stops being true, that test
    // is guarding nothing and should be revisited rather than left passing.
    assert.ok(!('from_model' in buildHandoffBody({ project: 'p', content: 'c' }, { clientTool: 'claude-code' })));
  });

  it('so no handoff tip states it unconditionally', () => {
    const claimsModel = /\bmodels?\b/i;
    const conditional = /\bwhen\b|\bif\b|\bunless\b/i;
    const handoffTips = TIPS.filter((tip) => String(tip.anchor).includes('handoff'));
    assert.ok(handoffTips.length > 0, 'no handoff tips found — the filter has stopped matching');
    for (const tip of handoffTips) {
      if (!claimsModel.test(tip.text)) continue;
      assert.match(
        tip.text, conditional,
        `"${tip.text}" promises the model is recorded; the code records it only when the AI names it`,
      );
    }
  });
});
