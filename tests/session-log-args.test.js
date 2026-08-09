// v1.26.61 — Eric's bug #9: a whole session log discarded because `model` was absent.
//
// The client guard that produced his error is correct and stays; what was wrong is that
// two of the three required fields did not need to be required. `tool` is a value the MCP
// process already holds in a constant, and `model` is one we can genuinely live without —
// far more cheaply than we can live without the entire session record, which is what
// requiring it costs when it goes missing.
//
// See openspec/changes/archive/v1.26.61-log-session-required-args/proposal.md.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSessionLogBody } from '../mcp/lib/session-log-body.js';
import { bucketLabel, UNREPORTED } from '../src/utils/session-buckets.js';
import { findMissingArgs } from '../mcp/lib/required-args.js';

describe('buildSessionLogBody — what actually goes to the server', () => {
  const clientTool = 'cursor';

  it('passes through everything the caller supplied', () => {
    const body = buildSessionLogBody({
      summary: 'did a thing', tool: 'codex', model: 'gpt-5', machine: 'box',
      details: { project: 'p' },
    }, { clientTool });
    assert.deepEqual(body, {
      summary: 'did a thing', tool: 'codex', model: 'gpt-5', machine: 'box',
      details: { project: 'p' },
    });
  });

  it('fills tool from the client when the caller omitted it', () => {
    // The value the process already knows. Asking the caller to repeat it is asking to be
    // told something we hold in a constant — and that ask is what failed three times.
    const body = buildSessionLogBody({ summary: 's' }, { clientTool });
    assert.equal(body.tool, 'cursor');
  });

  it('does not override a tool the caller did supply', () => {
    const body = buildSessionLogBody({ summary: 's', tool: 'opencode' }, { clientTool });
    assert.equal(body.tool, 'opencode');
  });

  it('treats an empty or blank tool as absent', () => {
    // Whitespace counts here because `tool` is defaulted rather than guard-enforced —
    // see the separate block below for why `summary` uses a stricter-matching rule.
    for (const empty of ['', '   ', null, undefined]) {
      const body = buildSessionLogBody({ summary: 's', tool: empty }, { clientTool });
      assert.equal(body.tool, 'cursor', `tool=${JSON.stringify(empty)} should fall back`);
    }
  });

  it('leaves model absent rather than inventing one', () => {
    // There is no signal for the model anywhere in the MCP process. Writing "unknown"
    // would put a fabricated value into the column that feeds the model distribution.
    const body = buildSessionLogBody({ summary: 's' }, { clientTool });
    assert.ok(!('model' in body), 'model must not be fabricated');
  });

  it('a blank model is dropped, not sent as an empty string', () => {
    const body = buildSessionLogBody({ summary: 's', model: '  ' }, { clientTool });
    assert.ok(!('model' in body));
  });

  it('the summary is never defaulted', () => {
    // It is the one field with no source but the caller, so it stays required. A body
    // with no summary must not silently become a row that says nothing.
    const body = buildSessionLogBody({}, { clientTool });
    assert.ok(!('summary' in body));
  });

  it('reproduces Eric\'s call: summary only, and it now produces a usable body', () => {
    // The exact shape that arrived at the tool in bug #9. Before this change the guard
    // rejected it for two missing fields and the session log was lost.
    const body = buildSessionLogBody({ summary: '本次工作摘要' }, { clientTool: 'claude-code' });
    assert.equal(body.summary, '本次工作摘要');
    assert.equal(body.tool, 'claude-code');
    assert.ok(!('model' in body));
  });
});

describe('bucketLabel — an absent tool or model is named, not coerced', () => {
  it('passes a real value through', () => {
    assert.equal(bucketLabel('claude-opus-5'), 'claude-opus-5');
  });

  it('names the absence instead of keying on null', () => {
    // Without this, `byModel[row.model]` produces a chart category literally called
    // "null" — a bucket named after a JavaScript coercion. Requirement 7 of the console
    // consolidation is that absence is carried by the data, not rendered as a value.
    for (const absent of [null, undefined, '', '   ']) {
      assert.equal(bucketLabel(absent), UNREPORTED, `${JSON.stringify(absent)} must be named`);
    }
  });

  it('the label is not something a tool or model could legitimately be called', () => {
    // A real tool named the same as the bucket would merge with the unreported ones.
    assert.match(UNREPORTED, /未回報|unreported/i);
    assert.notEqual(UNREPORTED, 'null');
    assert.notEqual(UNREPORTED, 'unknown');
  });

  it('groups every absent form into one bucket', () => {
    const counts = {};
    for (const row of [{ model: null }, { model: '' }, { model: undefined }, { model: 'gpt-5' }]) {
      const k = bucketLabel(row.model);
      counts[k] = (counts[k] || 0) + 1;
    }
    assert.equal(counts[UNREPORTED], 3, 'the three absent forms are one bucket, not three');
    assert.equal(counts['gpt-5'], 1);
    assert.equal(Object.keys(counts).length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The declarations have to agree with the decision, or the guard rejects the call
// before any of the code above runs.
// ─────────────────────────────────────────────────────────────────────────────

describe('the declared contract matches what the code does', () => {
  // v1.26.104 — fileURLToPath, not .pathname. On Windows a file: URL pathname is
  // '/C:/Users/...'; node then resolves that against the current drive root and looks for
  // 'C:C:Users...'. This file threw MODULE_NOT_FOUND / ENOENT on every Windows run while
  // passing on macOS, where the pathname happens to be a valid path.
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

  it('ownmind_log_session declares only summary as required', () => {
    // The client guard rejects a call from this list before buildSessionLogBody is
    // reached, so re-adding tool or model here would restore the bug with every test
    // above still green.
    const mcp = read('mcp/index.js');
    const from = mcp.indexOf('name: "ownmind_log_session"');
    assert.ok(from > 0, 'ownmind_log_session is not declared');
    // Bounded by the next tool declaration, not the next `},` — the schema nests
    // (`details` has its own properties), so the naive slice ended before `required`.
    const next = mcp.indexOf('name: "ownmind_', from + 10);
    const block = mcp.slice(from, next > from ? next : undefined);
    const required = block.match(/required: \[([^\]]*)\]/);
    assert.ok(required, 'ownmind_log_session has no required list');
    assert.equal(
      required[1].replace(/["'\s]/g, ''),
      'summary',
      'only summary may be required; tool is defaulted and model is optional',
    );
  });

  it('the server asks for no more than the client promises to send', () => {
    // The two were out of step in the other direction before: the endpoint required
    // tool and model while its own columns were nullable.
    const route = read('src/routes/session.js');
    const m = route.match(/requireFields\(req\.body, \[([^\]]*)\]\)/);
    assert.ok(m, 'POST /api/session has no requireFields call');
    assert.equal(m[1].replace(/["'\s]/g, ''), 'summary');
  });

  it('report_bug describes how to learn the phrase without containing it', () => {
    // Eric's second finding was that the description never said what the user must type,
    // so the user guessed and was refused. The first fix wrote the phrase into the
    // description — which adversarial review rightly called out: an LLM that knows the
    // exact string needed to pass a check will fill it in rather than interrupt itself,
    // and that check is the only human-in-the-loop gate on filing a report.
    //
    // So the description carries the *route* to the phrase, not the phrase. The server's
    // refusal already names it (src/utils/bug-report-helpers.js:22), so one round trip
    // turns into the AI showing the user the exact word.
    //
    // v1.26.97: the "MUST NOT auto-fill — the backend rejects it" wording is gone, because
    // the backend does not (bug #18: two reports were filed exactly that way). Keeping the
    // phrase out of the description still matters — that was always the part doing the work
    // — so that assertion stays. What replaced the false claim is an honest one plus a
    // declaration field, deliberately worded as an obligation rather than as notice that
    // the check is toothless.
    const mcp = read('mcp/index.js');
    const desc = mcp.slice(mcp.indexOf('confirm_string: {'));
    const line = desc.slice(0, desc.indexOf('},'));
    assert.doesNotMatch(line, /送出/,
      'the phrase must not appear in an AI-facing description — that is what makes auto-filling easy');
    assert.doesNotMatch(line, /backend rejects|MUST NOT auto-fill/,
      'the description must not claim a check the server does not perform');
    assert.match(line, /this one is on you/,
      'and must still put the obligation on the AI');
    assert.match(line, /server refuses/,
      'the description must tell the AI how to obtain the phrase, or the user is left guessing');
  });

  it('the server error still names the phrase, which is what that route depends on', () => {
    // If this ever stops naming it, the description above becomes a dead end.
    const helper = read('src/utils/bug-report-helpers.js');
    assert.match(helper, /需要使用者親口輸入「送出」/);
  });
});

describe('the builder never strips what the guard let through', () => {
  // Found in adversarial review. The guard and the server both count only the empty
  // string as missing; an earlier version of this module also treated whitespace as
  // missing, so `summary: "   "` passed the guard, was stripped here, and reached the
  // server without a summary — a generic 400 instead of the clear client-side error.
  // That is precisely the loop this release exists to end, reintroduced by the fix.
  const clientTool = 'claude-code';

  it('a whitespace-only summary survives, because the guard accepted it', () => {
    const body = buildSessionLogBody({ summary: '   ' }, { clientTool });
    assert.equal(body.summary, '   ');
  });

  it('the two rules agree on every value the guard is asked about', () => {
    for (const v of ['', '   ', 'x', null, undefined]) {
      const guardSaysMissing = findMissingArgs('ownmind_log_session', { summary: v }, ['summary']).length > 0;
      const builderDropsIt = !('summary' in buildSessionLogBody({ summary: v }, { clientTool }));
      assert.equal(
        builderDropsIt, guardSaysMissing,
        `summary=${JSON.stringify(v)}: guard and builder must agree, or the call fails at the server`,
      );
    }
  });

  it('but a blank tool still falls back — the guard does not enforce that one', () => {
    assert.equal(buildSessionLogBody({ summary: 's', tool: '   ' }, { clientTool }).tool, clientTool);
  });
});
