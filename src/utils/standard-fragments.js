/**
 * Reading a team standard whose text lives in child rows.
 *
 * A `team_standard` comes in two shapes. Either its text is on its own `content`, or the
 * upload split it into `standard_detail` rows keyed by `metadata.parent_id` and left the
 * parent holding one line of boilerplate. Both are read the same way — by id — and until
 * v1.26.146 the second shape answered with the boilerplate and no indication that anything
 * was missing. A short standard and a standard read short looked identical (issue #89).
 *
 * So the read answers with the fragments rather than with advice about how to find them. Two
 * instructions have now been written for this and both were correct when written and wrong
 * later; the reader cannot tell which shape it is holding, so it is not asked to.
 *
 * The parent's own `content` is never rewritten here. `ownmind_get` tells an assistant to read
 * a memory in full before `ownmind_update` so it does not overwrite the rest of it — under a
 * design that merged fragments into `content`, that sentence would be an instruction to
 * flatten every fragment into the parent and orphan the real rows.
 */

import { buildReadableWhere } from './memory-visibility.js';

/**
 * Characters of fragment text one read may carry, counted over title plus content.
 *
 * The ceiling this guards is the caller's tool-output limit, which is counted in tokens, and
 * these documents are Chinese — roughly a token per character. An earlier draft said 50,000,
 * which would have passed a response the caller could not receive: the guard permitting
 * exactly what it was built to prevent. Largest standard measured 2026-08-12 is 14,091
 * characters, so this leaves headroom without inviting the failure back.
 *
 * Exported so a test can pin the number the server actually uses. A test that only ever
 * injects a budget stays green when this constant becomes Infinity.
 */
export const FRAGMENT_CHAR_BUDGET = 20000;

/** How a reader that received a partial answer reaches the rest. */
const TRUNCATION_NOTICE =
  'Truncated at the size limit. For every fragment of this standard: ' +
  "ownmind_get({ type: 'standard_detail', parent_id: <this memory's id> }).";

/**
 * The document position the sync recorded, or null when it recorded none.
 *
 * `metadata.ord` is written by `POST /batch-sync-standard` from the chunk's index in the
 * incoming array. Standards synced before v1.26.146 have none until their next sync, and fall
 * back to row id. Note the explicit null check: `ord || id` would send section 0 — the first
 * section of every document — to the back of the list.
 *
 * @param {object} row
 * @returns {number|null}
 */
function ordinalOf(row) {
  const raw = row?.metadata?.ord;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * Shape fragment rows into the payload a read carries, ordered and within budget.
 *
 * Ordering happens here rather than only in SQL so that it is reachable by a test. A sort that
 * lives only in an `ORDER BY` is invisible to every fake-backed test in this repo: the fake
 * returns its fixture whatever query it was handed.
 *
 * @param {Array<object>} rows fragment rows as the database returns them
 * @param {object} [options]
 * @param {number} [options.budget] characters of title + content to allow
 * @returns {{fragments: Array<object>, fragments_total: number, fragments_returned: number,
 *            fragments_truncated: boolean, fragments_truncated_notice?: string}}
 */
export function buildStandardFragments(rows, { budget = FRAGMENT_CHAR_BUDGET } = {}) {
  const all = Array.isArray(rows) ? rows.slice() : [];

  // Rows the sync has numbered come first, in document order; the rest follow by id. A single
  // standard is all one or all the other, because a sync numbers every chunk it sends.
  all.sort((a, b) => {
    const ordA = ordinalOf(a);
    const ordB = ordinalOf(b);
    if (ordA !== null && ordB !== null) return ordA - ordB;
    if (ordA !== null) return -1;
    if (ordB !== null) return 1;
    return Number(a.id) - Number(b.id);
  });

  const fragments = [];
  let spent = 0;
  for (const row of all) {
    const cost = String(row.title ?? '').length + String(row.content ?? '').length;
    // The first fragment is always returned whole. Returning an empty list, or a sliced
    // fragment, would both answer a read with something that reads as complete and is not.
    if (fragments.length > 0 && spent + cost > budget) break;
    fragments.push({
      id: row.id,
      title: row.title,
      content: row.content,
      level: row.metadata?.level,
    });
    spent += cost;
  }

  const truncated = fragments.length < all.length;
  return {
    fragments,
    fragments_total: all.length,
    fragments_returned: fragments.length,
    fragments_truncated: truncated,
    ...(truncated && { fragments_truncated_notice: TRUNCATION_NOTICE }),
  };
}

/**
 * SQL for "the fragments of one standard this caller may read".
 *
 * `$1` is the caller, `$2` the parent id as text. The parent is matched against the JSON value
 * as text rather than cast to int, for the same reason `buildReadableWhere` does it: a
 * malformed `parent_id` then matches nothing instead of aborting the query.
 */
const FRAGMENTS_SQL = `SELECT m.id, m.title, m.content, m.metadata FROM memories m
   WHERE m.type = 'standard_detail'
     AND m.status = 'active'
     AND m.metadata->>'parent_id' = $2
     AND ${buildReadableWhere({ alias: 'm', userParam: '$1' })}
   ORDER BY CASE WHEN jsonb_typeof(m.metadata->'ord') = 'number'
                 THEN (m.metadata->>'ord')::int ELSE NULL END NULLS LAST, m.id`;

/** How many active sibling fragments one standard has, for a fragment read on its own. */
const SIBLING_COUNT_SQL = `SELECT COUNT(*)::int AS n FROM memories m
   WHERE m.type = 'standard_detail'
     AND m.status = 'active'
     AND m.metadata->>'parent_id' = $2
     AND ${buildReadableWhere({ alias: 'm', userParam: '$1' })}`;

/**
 * Complete a single memory read.
 *
 * A `team_standard` gains its fragments; a `standard_detail` gains a pointer back to the
 * standard it is a section of. Everything else is returned untouched and costs no query.
 *
 * The pointer exists because search can hand back a fragment instead of the parent — measured
 * against production, searching a standard's exact title returns the parent first every time,
 * but searching keywords can surface a section, and a section read alone looks exactly like a
 * short complete standard. That is the defect this release exists to remove, one layer over.
 *
 * @param {object} row the memory row
 * @param {object} deps
 * @param {(text: string, params: Array) => Promise<{rows: Array}>} deps.query
 * @param {number|string} deps.userId the caller
 * @param {number} [deps.budget]
 * @returns {Promise<object>} the row, with fields added where they apply
 */
export async function attachStandardFragments(row, { query, userId, budget } = {}) {
  if (!row || typeof row !== 'object') return row;

  if (row.type === 'team_standard') {
    const result = await query(FRAGMENTS_SQL, [userId, String(row.id)]);
    const rows = result?.rows ?? [];
    // No fragments means the text is on this row already. Adding an empty array would make
    // that indistinguishable from a standard whose fragments are hidden from this caller.
    if (rows.length === 0) return row;
    return { ...row, ...buildStandardFragments(rows, budget === undefined ? {} : { budget }) };
  }

  if (row.type === 'standard_detail') {
    const parentId = row.metadata?.parent_id;
    if (parentId === undefined || parentId === null || parentId === '') return row;
    const result = await query(SIBLING_COUNT_SQL, [userId, String(parentId)]);
    return {
      ...row,
      parent_id: parentId,
      parent_fragment_count: result?.rows?.[0]?.n ?? 0,
    };
  }

  return row;
}
