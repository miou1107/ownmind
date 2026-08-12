import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenize,
  itemMatchesTokens,
  bigrams,
  bigramThreshold,
  isBigramEligible,
} from '../shared/memory-search-tokens.js';
import { buildSearchWhere } from '../src/utils/memory-search-query.js';

/**
 * v1.26.156 — search split the query on whitespace, and that is a language assumption.
 *
 * English arrives pre-tokenized. Chinese does not: a whole phrase becomes one token and is
 * matched as one literal substring. Measured 2026-08-12 against the live account:
 *
 *   收工六項自檢   → 0 results
 *   收工           → found
 *   交接六項自檢   → found
 *
 * The stored title is 「[團隊] 收工／交接六項自檢」. Typing it from memory, two characters
 * short, returned nothing — and nothing is indistinguishable from "you have no such memory",
 * which is the one failure this product cannot afford.
 */

/** The memory the bug was found on, as it is actually stored. */
const WRAP_UP = {
  title: '[團隊] 收工／交接六項自檢',
  content: '聽到收尾、交接、下班、wrap up 這類話時，先跑完以下六項檢查再回報',
  tags: ['trigger:wrap-up', 'trigger:handoff'],
  code: null,
};

const UNRELATED = {
  title: 'Vibe Coding 測試與版本控制',
  content: '測試與版本控制的規範，跟收尾無關',
  tags: [],
  code: null,
};

const IRON_RULE = {
  title: 'set -e 腳本裡的 2>/dev/null 是紅旗',
  content: '它讓失敗變成沉默，寫的時候不准加',
  tags: ['trigger:debug'],
  code: 'IR-002',
};

describe('v1.26.156 — a Chinese phrase typed from memory still finds it', () => {
  it('the reported query now matches', () => {
    assert.equal(itemMatchesTokens(WRAP_UP, tokenize('收工六項自檢')), true);
  });

  it('the two that already worked still work', () => {
    // Both are exact substrings of the stored title, so they went through the whole-token
    // path before this change and must still take it.
    assert.equal(itemMatchesTokens(WRAP_UP, tokenize('收工')), true);
    assert.equal(itemMatchesTokens(WRAP_UP, tokenize('交接六項自檢')), true);
  });

  it('and the words the standard lists in its own text', () => {
    for (const q of ['收尾', '下班', 'wrap up']) {
      assert.equal(itemMatchesTokens(WRAP_UP, tokenize(q)), true, q);
    }
  });

  it('does not start matching unrelated memories', () => {
    // The whole risk of loosening a filter. 收工六項自檢 shares no window with either of
    // these, and a rule that returned them would be worse than the bug.
    assert.equal(itemMatchesTokens(UNRELATED, tokenize('收工六項自檢')), false);
    assert.equal(itemMatchesTokens(IRON_RULE, tokenize('收工六項自檢')), false);
  });

  it('leaves exact matching alone for everything else', () => {
    assert.equal(itemMatchesTokens(UNRELATED, tokenize('版本控制')), true);
    assert.equal(itemMatchesTokens(IRON_RULE, tokenize('IR-002')), true);
    assert.equal(itemMatchesTokens(IRON_RULE, tokenize('紅旗')), true);
  });
});

describe('v1.26.156 — which tokens get the window treatment', () => {
  it('only Chinese, and only when long enough to be specific', () => {
    assert.equal(isBigramEligible('收工六項自檢'), true);
    assert.equal(isBigramEligible('收工'), false, 'two characters is the phrase itself');
    assert.equal(isBigramEligible('版本控'), false, 'three is still too short to be evidence');
    assert.equal(isBigramEligible('deployment'), false, 'English is already split on spaces');
  });

  it('the windows overlap, so an inserted character costs one and not the rest', () => {
    assert.deepEqual(bigrams('收工六項自檢'), ['收工', '工六', '六項', '項自', '自檢']);
  });

  it('the threshold is a majority, not all and not one', () => {
    // All of them is the exact phrase again — the thing that fails. One of them would match
    // a two-character coincidence anywhere in a long document.
    assert.equal(bigramThreshold(5), 3);
    assert.equal(bigramThreshold(1), 1);
  });

  it('the reported case clears it with one window to spare', () => {
    // 工六 is the one broken by the ／交接 sitting in the middle of the stored title.
    const windows = bigrams('收工六項自檢');
    const title = WRAP_UP.title.toLowerCase();
    const hit = windows.filter((g) => title.includes(g));
    assert.deepEqual(hit, ['收工', '六項', '項自', '自檢']);
    assert.ok(hit.length >= bigramThreshold(windows.length));
  });
});

describe('v1.26.156 — the online SQL says the same thing as the offline matcher', () => {
  /**
   * These two paths are one rule in two languages, which is what
   * shared/memory-search-tokens.js exists to prevent drifting. The builder is a pure
   * function, so the shape can be checked without a live Postgres — what cannot be checked
   * here is that Postgres agrees, and that is what the deploy is for.
   */
  it('a Chinese phrase gets the window branch, over the prose columns only', () => {
    const built = buildSearchWhere(tokenize('收工六項自檢'), 2);
    assert.match(built.whereClause, /unnest\(\$3::text\[\]\) g WHERE title ILIKE g\) >= 3/);
    assert.match(built.whereClause, /unnest\(\$3::text\[\]\) g WHERE content ILIKE g\) >= 3/);
    // `code` and `tags` hold identifiers — IR-003, trigger:commit. A partial match there is
    // noise, and the offline matcher excludes them for the same reason.
    assert.doesNotMatch(built.whereClause, /g WHERE code ILIKE g/);
    assert.doesNotMatch(built.whereClause, /g WHERE t ILIKE g/);
  });

  it('the windows go in as one array parameter, escaped', () => {
    const built = buildSearchWhere(tokenize('收工六項自檢'), 2);
    assert.deepEqual(built.params[1], ['%收工%', '%工六%', '%六項%', '%項自%', '%自檢%']);
  });

  it('a short or English query is built exactly as before', () => {
    const built = buildSearchWhere(tokenize('版本 控制'), 2);
    assert.doesNotMatch(built.whereClause, /unnest\(\$\d+::text\[\]\)/);
    assert.deepEqual(built.params, ['%版本%', '%控制%']);
  });

  it('the ORDER BY still points at the first token, not at a window array', () => {
    // The parameter numbering now advances by two for a Chinese token. Pointing the title
    // sort at the array instead would be a type error at query time, on the one code path
    // no unit test can reach without a database.
    const built = buildSearchWhere(tokenize('收工六項自檢 部署'), 2);
    assert.equal(built.orderClause, '(title ILIKE $2) DESC, updated_at DESC');
    assert.equal(built.params[0], '%收工六項自檢%');
  });

  it('parameter numbering stays in step across mixed tokens', () => {
    const built = buildSearchWhere(tokenize('收工六項自檢 部署'), 2);
    // $2 whole phrase, $3 its windows, $4 the second token — which is two characters and
    // therefore has none.
    assert.match(built.whereClause, /title ILIKE \$4/);
    assert.equal(built.params.length, 3);
    assert.equal(built.params[2], '%部署%');
  });
});
