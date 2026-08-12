// v1.26.146 — issue #89. Seven team standards answered a read with one line of upload
// boilerplate while their text sat in child rows, and nothing in the answer said so. A short
// standard and a standard read short were indistinguishable.
//
// These tests cover the shaping and the wiring. Two deliberate choices, both from review:
//
//   - Every ordering fixture is SHUFFLED. A fixture in the order you expect back proves
//     nothing: deleting the sort leaves it green.
//   - The budget tests assert the exported production constant, not only an injected one.
//     Injecting the budget and never naming the real number lets `FRAGMENT_CHAR_BUDGET = Infinity`
//     pass every test in this file.
//
// What these tests cannot reach: SQL semantics. `attachStandardFragments` takes an injected
// query, so a fake proves which parameters were bound and when the lookup runs, never that the
// predicate means what it says against Postgres. That is verified against a live database
// before release, the same standing limitation stated in tests/memory-visibility.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAGMENT_CHAR_BUDGET,
  buildStandardFragments,
  attachStandardFragments,
  planChunkSync,
} from '../src/utils/standard-fragments.js';

/** A fragment row as Postgres hands it back. */
const frag = (id, { ord, level = 1, title = `t${id}`, content = `c${id}` } = {}) => ({
  id,
  type: 'standard_detail',
  title,
  content,
  metadata: { parent_id: 152, hash: 'h', level, ...(ord === undefined ? {} : { ord }) },
});

describe('buildStandardFragments — order', () => {
  it('orders by ord when the sync has written one, whatever order the rows arrive in', () => {
    const shuffled = [frag(300, { ord: 2 }), frag(140, { ord: 0 }), frag(999, { ord: 1 })];
    const out = buildStandardFragments(shuffled);
    assert.deepEqual(out.fragments.map(f => f.id), [140, 999, 300]);
  });

  it('falls back to id for standards that have not been re-synced yet', () => {
    const shuffled = [frag(142), frag(136), frag(139)];
    const out = buildStandardFragments(shuffled);
    assert.deepEqual(out.fragments.map(f => f.id), [136, 139, 142]);
  });

  it('does not let ord 0 be mistaken for "no ord"', () => {
    // `ord || id` would send the first section of every document to the back.
    const out = buildStandardFragments([frag(500, { ord: 1 }), frag(400, { ord: 0 })]);
    assert.deepEqual(out.fragments.map(f => f.id), [400, 500]);
  });
});

describe('buildStandardFragments — what a fragment carries', () => {
  it('keeps a heading that stores no body text', () => {
    // Measured on production: fragment 137's hash is the SHA-256 of the empty string.
    const out = buildStandardFragments([frag(1, { content: '' }), frag(2, { content: null })]);
    assert.equal(out.fragments.length, 2);
    assert.equal(out.fragments[0].content, '');
    assert.equal(out.fragments[1].content, null);
  });

  it('carries title, content and level, and not the parent bookkeeping', () => {
    const out = buildStandardFragments([frag(1, { level: 3, title: 'A > B > C' })]);
    assert.deepEqual(out.fragments[0], { id: 1, title: 'A > B > C', content: 'c1', level: 3 });
  });
});

describe('buildStandardFragments — the budget', () => {
  it('pins the production budget, so raising it silently fails here', () => {
    assert.equal(FRAGMENT_CHAR_BUDGET, 20000);
  });

  it('returns everything when the standard fits', () => {
    const rows = [frag(1, { content: 'x'.repeat(10) }), frag(2, { content: 'y'.repeat(10) })];
    const out = buildStandardFragments(rows, { budget: 100 });
    assert.equal(out.fragments_total, 2);
    assert.equal(out.fragments_returned, 2);
    assert.equal(out.fragments_truncated, false);
    assert.equal(out.fragments_truncated_notice, undefined);
  });

  it('counts title as well as content', () => {
    // Two rows of 10 content characters and 10 title characters each: 40 in total.
    // Counting content alone would fit them inside a budget of 25 and never truncate.
    const rows = [
      frag(1, { title: 'a'.repeat(10), content: 'x'.repeat(10) }),
      frag(2, { title: 'b'.repeat(10), content: 'y'.repeat(10) }),
    ];
    const out = buildStandardFragments(rows, { budget: 25 });
    assert.equal(out.fragments_returned, 1);
    assert.equal(out.fragments_truncated, true);
  });

  it('declares the truncation and names the call that reaches the rest', () => {
    const rows = [frag(1, { content: 'x'.repeat(50) }), frag(2, { content: 'y'.repeat(50) })];
    const out = buildStandardFragments(rows, { budget: 60 });
    assert.equal(out.fragments_total, 2);
    assert.equal(out.fragments_returned, 1);
    assert.equal(out.fragments_truncated, true);
    assert.match(out.fragments_truncated_notice, /standard_detail/);
    assert.match(out.fragments_truncated_notice, /parent_id/);
  });

  it('returns an oversized first fragment whole rather than an empty list or a slice', () => {
    const body = 'x'.repeat(500);
    const out = buildStandardFragments([frag(1, { content: body }), frag(2)], { budget: 10 });
    assert.equal(out.fragments_returned, 1);
    assert.equal(out.fragments[0].content, body, 'the fragment must not be silently cut');
    assert.equal(out.fragments_truncated, true);
  });

  it('stops at the budget rather than after the first fragment that crosses it', () => {
    const rows = [1, 2, 3, 4].map(i => frag(i, { title: '', content: 'x'.repeat(20) }));
    const out = buildStandardFragments(rows, { budget: 45 });
    assert.equal(out.fragments_returned, 2);
    assert.equal(out.fragments_total, 4);
  });
});

/** A query fake that records what it was asked and answers from a script. */
function fakeQuery(rowsByCall = [[]]) {
  const calls = [];
  let n = 0;
  const query = async (text, params) => {
    calls.push({ text, params });
    return { rows: rowsByCall[n++] ?? [] };
  };
  return { query, calls };
}

describe('attachStandardFragments — when the lookup runs at all', () => {
  it('looks up fragments for a team standard', async () => {
    const { query, calls } = fakeQuery([[frag(2), frag(1)]]);
    const row = { id: 152, type: 'team_standard', content: 'boilerplate' };
    const out = await attachStandardFragments(row, { query, userId: 7 });
    assert.equal(calls.length, 1);
    assert.deepEqual(out.fragments.map(f => f.id), [1, 2]);
    assert.equal(out.content, 'boilerplate', 'the row\'s own content is never rewritten');
  });

  it('adds no field to a standard whose text is on its own record', async () => {
    const { query } = fakeQuery([[]]);
    const out = await attachStandardFragments(
      { id: 869, type: 'team_standard', content: 'the whole rule' }, { query, userId: 7 });
    assert.equal('fragments' in out, false);
    assert.equal('fragments_total' in out, false);
  });

  it('runs no lookup for any other memory type', async () => {
    // Several types, including standard_detail itself: a mutation widening the condition to
    // `startsWith("team")` or adding standard_detail stays green against one type alone.
    for (const type of ['iron_rule', 'project', 'env', 'profile', 'coding_standard', 'portfolio']) {
      const { query, calls } = fakeQuery([[frag(1)]]);
      const out = await attachStandardFragments({ id: 1, type }, { query, userId: 7 });
      assert.equal(calls.length, 0, `${type} must not trigger a fragment lookup`);
      assert.equal('fragments' in out, false);
    }
  });

  it('binds the caller and the parent, and binds them the right way round', async () => {
    const { query, calls } = fakeQuery([[frag(1)]]);
    await attachStandardFragments({ id: 152, type: 'team_standard' }, { query, userId: 7 });
    // The parent id is matched as text against the JSON value; the caller is the visibility
    // parameter. Swapping them reads as plausible SQL and hides every standard from everyone.
    assert.deepEqual(calls[0].params, [7, '152']);
    assert.match(calls[0].text, /metadata->>'parent_id'\s*=\s*\$2/);
    assert.match(calls[0].text, /m\.status\s*=\s*'active'/);
    assert.match(calls[0].text, /ORDER BY/);
  });
});

describe('attachStandardFragments — a fragment read on its own', () => {
  it('tells the reader which standard it belongs to and how many sections there are', async () => {
    const { query, calls } = fakeQuery([[{ n: 17 }]]);
    const out = await attachStandardFragments(
      { id: 341, type: 'standard_detail', metadata: { parent_id: 345, level: 2 } },
      { query, userId: 7 });
    assert.equal(out.parent_id, 345);
    assert.equal(out.parent_fragment_count, 17);
    assert.equal(calls.length, 1);
  });

  it('says nothing rather than something wrong when the fragment has no parent recorded', async () => {
    const { query, calls } = fakeQuery([[{ n: 0 }]]);
    const out = await attachStandardFragments(
      { id: 341, type: 'standard_detail', metadata: {} }, { query, userId: 7 });
    assert.equal('parent_id' in out, false);
    assert.equal(calls.length, 0);
  });

  it('counts the siblings with the caller and the parent bound the right way round', async () => {
    // The fragment query has this assertion and the count query did not, so swapping the two
    // parameters here — the same mutation, one function down — used to survive.
    const { query, calls } = fakeQuery([[{ n: 17 }]]);
    await attachStandardFragments(
      { id: 341, type: 'standard_detail', metadata: { parent_id: 345 } }, { query, userId: 7 });
    assert.deepEqual(calls[0].params, [7, '345']);
    assert.match(calls[0].text, /metadata->>'parent_id'\s*=\s*\$2/);
    assert.match(calls[0].text, /m\.status\s*=\s*'active'/);
  });
});

describe('planChunkSync — what a sync does to each fragment', () => {
  const chunk = (title, hash = `h-${title}`) => ({ title, content: `c-${title}`, hash, level: 1 });
  const existing = (id, title, hash = `h-${title}`, ord = null) => ({ id, title, hash, ord });

  it('inserts a chunk nobody has seen, carrying its position', () => {
    const plan = planChunkSync([chunk('a'), chunk('b')], []);
    assert.deepEqual(plan.map(s => [s.action, s.ord]), [['insert', 0], ['insert', 1]]);
  });

  it('updates a chunk whose text changed, and moves its position with it', () => {
    const plan = planChunkSync([chunk('a', 'new')], [existing(1, 'a', 'old', 0)]);
    assert.deepEqual(plan, [{ action: 'update', chunk: chunk('a', 'new'), ord: 0, id: 1 }]);
  });

  it('backfills a standard that predates ordinals instead of leaving it on id order', () => {
    // Every row unchanged, every row without an ord. Dropping this branch is invisible to a
    // content-only test and leaves legacy standards permanently in id order — the defect the
    // ordinals exist to fix.
    const plan = planChunkSync([chunk('a'), chunk('b')], [existing(2, 'b'), existing(1, 'a')]);
    assert.deepEqual(plan.map(s => s.action), ['reorder', 'reorder']);
    assert.deepEqual(plan.map(s => [s.id, s.ord]), [[1, 0], [2, 1]]);
  });

  it('leaves a row alone when its text and its position both match', () => {
    const plan = planChunkSync([chunk('a')], [existing(1, 'a', 'h-a', 0)]);
    assert.deepEqual(plan.map(s => s.action), ['unchanged']);
  });

  it('treats position 0 as a position, so the first section is not reordered forever', () => {
    const plan = planChunkSync([chunk('a')], [existing(1, 'a', 'h-a', 0)]);
    assert.equal(plan[0].action, 'unchanged', 'ord 0 must not read as "no ord"');
  });

  it('records a move as a reorder, not as an edit', () => {
    const plan = planChunkSync(
      [chunk('b'), chunk('a')],
      [existing(1, 'a', 'h-a', 0), existing(2, 'b', 'h-b', 1)]);
    assert.deepEqual(plan.map(s => [s.action, s.id, s.ord]), [['reorder', 2, 0], ['reorder', 1, 1]]);
  });

  it('disables a section the sync no longer sends, and only that one', () => {
    const plan = planChunkSync([chunk('a')], [existing(1, 'a', 'h-a', 0), existing(9, 'gone')]);
    assert.deepEqual(plan.map(s => s.action), ['unchanged', 'disable']);
    assert.equal(plan[1].id, 9);
  });

  it('turns a renamed heading into a disable plus an insert, which is why position is recorded', () => {
    const plan = planChunkSync([chunk('a2')], [existing(1, 'a1', 'h-a1', 0)]);
    assert.deepEqual(plan.map(s => s.action), ['insert', 'disable']);
    assert.equal(plan[0].ord, 0, 'the replacement takes the position, not a new row id');
  });

  it('survives an empty sync and an empty history', () => {
    assert.deepEqual(planChunkSync([], []), []);
    assert.deepEqual(planChunkSync([], [existing(1, 'a')]).map(s => s.action), ['disable']);
  });
});
