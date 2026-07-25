import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  tokenize,
  buildSearchWhere,
} from '../src/utils/memory-search-query.js';

/**
 * v1.26.37 — Bug #7 (option B) — improve keyword search
 *
 * The previous /api/memory/search built a single ILIKE '%q%' over title OR
 * content. That failed the "saved but can't find" symptom: multi-word queries
 * needed the whole phrase, tag-only hits were invisible, code hits invisible,
 * concept queries never matched.
 *
 * These tests pin the tokenizer + WHERE builder that the search handler will
 * consume. A pure function so tests don't need a live Postgres.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

describe('tokenize(q)', () => {
  it('splits on whitespace, drops empties', () => {
    assert.deepEqual(tokenize('iron rule sync'), ['iron', 'rule', 'sync']);
    assert.deepEqual(tokenize('  iron   rule  '), ['iron', 'rule']);
  });

  it('trims each token', () => {
    assert.deepEqual(tokenize('\tiron\nrule\t'), ['iron', 'rule']);
  });

  it('empty / whitespace-only input → []', () => {
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize('   '), []);
    assert.deepEqual(tokenize('\n\t'), []);
  });

  it('caps at 10 tokens to bound query size', () => {
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`).join(' ');
    const result = tokenize(many);
    assert.equal(result.length, 10);
    assert.equal(result[0], 't0');
    assert.equal(result[9], 't9');
  });

  it('non-string input → []', () => {
    assert.deepEqual(tokenize(null), []);
    assert.deepEqual(tokenize(undefined), []);
    assert.deepEqual(tokenize(42), []);
  });

  it('drops single-character tokens (would match ~everything, seq-scan cost)', () => {
    assert.deepEqual(tokenize('a iron b rule c'), ['iron', 'rule']);
    // If every token is single-char, result is empty → caller returns 400.
    assert.deepEqual(tokenize('a b c'), []);
  });
});

describe('buildSearchWhere(tokens, startingParamIndex)', () => {
  it('single token: matches title OR content OR code OR any tag', () => {
    const built = buildSearchWhere(['iron'], 2);
    assert.deepEqual(built.params, ['%iron%']);
    // ANDed across tokens (only 1 token here so no AND yet)
    assert.match(built.whereClause, /title ILIKE \$2/);
    assert.match(built.whereClause, /content ILIKE \$2/);
    assert.match(built.whereClause, /code ILIKE \$2/);
    // tags is text[] — need EXISTS unnest (COALESCE-wrapped is fine)
    assert.match(built.whereClause, /unnest\(/);
    assert.match(built.whereClause, /tags/);
    assert.match(built.whereClause, /t ILIKE \$2/);
  });

  it('multi-token: ANDs the tokens with distinct params', () => {
    const built = buildSearchWhere(['iron', 'rule'], 2);
    assert.deepEqual(built.params, ['%iron%', '%rule%']);
    // Two AND-joined groups
    const andCount = (built.whereClause.match(/\bAND\b/g) || []).length;
    assert.ok(andCount >= 1,
      `expected at least one AND between token groups; got: ${built.whereClause}`);
    assert.match(built.whereClause, /\$2/);
    assert.match(built.whereClause, /\$3/);
  });

  it('order clause ranks title-hit above other-field-hit for the first token', () => {
    const built = buildSearchWhere(['iron', 'rule'], 2);
    // first-token title match wins the tie
    assert.match(built.orderClause, /title ILIKE \$2/);
    assert.match(built.orderClause, /DESC/);
    assert.match(built.orderClause, /updated_at DESC/);
  });

  it('empty tokens → null (caller must 400)', () => {
    const built = buildSearchWhere([], 2);
    assert.equal(built, null);
  });

  it('respects startingParamIndex so callers can prefix params', () => {
    const built = buildSearchWhere(['iron'], 5);
    assert.match(built.whereClause, /\$5/);
    assert.doesNotMatch(built.whereClause, /\$1/);
    assert.doesNotMatch(built.whereClause, /\$2/);
  });

  it('escapes LIKE metacharacters in tokens so % and _ match literally', () => {
    // Without escaping, `100%` → `%100%%` which ILIKE reads as "any row with
    // '100' followed by anything" — matches way more than the user asked for.
    const built = buildSearchWhere(['100%'], 2);
    assert.deepEqual(built.params, ['%100\\%%']);
    // Same for underscore (single-char wildcard) and backslash (default LIKE escape).
    const b2 = buildSearchWhere(['a_b'], 2);
    assert.deepEqual(b2.params, ['%a\\_b%']);
    const b3 = buildSearchWhere(['x\\y'], 2);
    assert.deepEqual(b3.params, ['%x\\\\y%']);
  });
});

describe('memory.js /search wiring — uses the new builder', () => {
  const src = read('src/routes/memory.js');
  const searchStart = src.indexOf("router.get('/search'");
  assert.ok(searchStart > 0, 'search route not found');
  const searchEnd = src.indexOf("router.get('/:id'", searchStart);
  const SEARCH_BLOCK = src.slice(searchStart, searchEnd);

  it('imports the new helpers', () => {
    assert.match(src, /from '\.\.\/utils\/memory-search-query\.js'/);
    assert.match(src, /tokenize|buildSearchWhere/);
  });

  it('no longer uses the old single ILIKE `%q%` shape', () => {
    // The old query pattern: `(content ILIKE $2 OR title ILIKE $2)` with a
    // single param. Reject that literal shape so we don't regress.
    assert.doesNotMatch(SEARCH_BLOCK,
      /content ILIKE \$2 OR title ILIKE \$2\)\s*ORDER BY updated_at DESC/,
      'search handler must not use the pre-v1.26.37 single-ILIKE shape');
  });

  it('empty-after-tokenize returns 400', () => {
    // The handler must handle `q="   "` (400) too, not just missing q.
    assert.match(SEARCH_BLOCK, /400/);
  });
});
