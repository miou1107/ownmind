// v1.33.0 — the server says "this looks like #N" without a model.
//
// Trigram similarity over title+content is the whole mechanism behind the save-time
// duplicate check and the monthly candidate list. These prove the pure parts against a
// scripted query: the thresholds, the normalisation, the SQL shape, and the title markers
// that say a project memory has concluded or is waiting on someone. The worst case for the
// thresholds (two deploy checklists that differ in one host name) is measured against a real
// pg_trgm in tests/ai-keeps-the-memory.test.js, because only Postgres can compute it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIMILARITY_EXACT, SIMILARITY_RELATED, SIMILARITY_CANDIDATE, LESSON_REPEAT,
  normalizeForSimilarity, findSimilarMemories,
  concludedMarker, CONCLUDED_TITLE_REGEX, WAITING_REGEX, isWaiting,
} from '../src/lib/memory-similarity.js';

function scriptedQuery(answers) {
  const calls = [];
  const fn = async (text, values) => {
    calls.push({ text, values });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { rows: next || [] };
  };
  fn.calls = calls;
  return fn;
}

describe('the thresholds are the design, not a tuning knob', () => {
  it('exact is stricter than related, which is stricter than nothing', () => {
    assert.equal(SIMILARITY_EXACT, 0.98);
    assert.equal(SIMILARITY_RELATED, 0.45);
    assert.equal(SIMILARITY_CANDIDATE, 0.6);
    assert.equal(LESSON_REPEAT, 0.5);
    assert.ok(SIMILARITY_EXACT > SIMILARITY_CANDIDATE && SIMILARITY_CANDIDATE > SIMILARITY_RELATED);
  });
});

describe('normalizeForSimilarity', () => {
  it('lower-cases and collapses whitespace, joining title and content with one space', () => {
    assert.equal(normalizeForSimilarity('  Deploy   Checklist ', 'Step\n\n1:\tPULL'), 'deploy checklist step 1: pull');
  });

  it('tolerates a missing content', () => {
    assert.equal(normalizeForSimilarity('T', null), 't');
    assert.equal(normalizeForSimilarity(null, null), '');
  });
});

describe('findSimilarMemories — one query, two answers', () => {
  it('asks for the top rows of the same user, type and is_test above the related threshold', async () => {
    const q = scriptedQuery([[
      { id: 5, title: 'A', content: 'x'.repeat(300), similarity: 0.99 },
      { id: 6, title: 'B', content: 'short', similarity: 0.5 },
    ]]);
    const r = await findSimilarMemories(q, { userId: 7, type: 'project', title: 'A', content: 'x', isTest: false });
    assert.equal(q.calls.length, 1);
    const { text, values } = q.calls[0];
    assert.match(text, /similarity\(lower\(title \|\| ' ' \|\| content\), \$4\)/);
    assert.match(text, /status = 'active'/);
    assert.match(text, /is_test = \$3/);
    assert.match(text, /LIMIT 3/);
    assert.deepEqual(values, [7, 'project', false, 'a x', SIMILARITY_RELATED]);
    assert.equal(r.exact.id, 5, 'the first row at or above the exact threshold is the duplicate');
    assert.deepEqual(r.similar.map((s) => s.id), [5, 6]);
    assert.equal(r.similar[0].excerpt.length <= 160, true, 'the excerpt is cut for the relay');
    assert.equal(r.similar[1].excerpt, 'short');
  });

  it('answers no exact and an empty list when nothing is related', async () => {
    const r = await findSimilarMemories(scriptedQuery([[]]), { userId: 7, type: 'iron_rule', title: 'T', content: 'C' });
    assert.deepEqual(r, { exact: null, similar: [] });
  });
});

describe('concluded markers on a project title', () => {
  it('match at the start or the end, with or without brackets', () => {
    assert.equal(concludedMarker('【已過時】idaytour 的 Gemini 金鑰'), '已過時');
    assert.equal(concludedMarker('已結案 kkvin.com 轉址'), '已結案');
    assert.equal(concludedMarker('Vinutes v0.4.19 講者人數誤判（已合併）'), null, 'inside brackets of another kind is not a marker');
    assert.equal(concludedMarker('Vinutes v0.4.19 已合併'), '已合併');
    assert.equal(concludedMarker('PR #36 已關單'), '已關單');
    assert.equal(concludedMarker('第二批庫存卡請購：已完成'), '已完成', 'ending with the marker counts, whatever comes before');
    assert.equal(concludedMarker('已發布的網站首頁'), null, 'a word that merely begins with a marker is not one');
    assert.equal(concludedMarker('好好玩 Google Ad Manager 每月廣告收入'), null);
  });

  it('the SQL regex agrees with the JavaScript one', () => {
    assert.equal(typeof CONCLUDED_TITLE_REGEX, 'string');
    for (const title of ['【已發】網站首頁', '網站首頁【已發】', '已發 網站首頁']) {
      assert.ok(new RegExp(CONCLUDED_TITLE_REGEX).test(title), title);
      assert.ok(concludedMarker(title), title);
    }
  });
});

describe('waiting markers', () => {
  it('read the title or the first line of the content', () => {
    assert.equal(isWaiting('待決定：Ad Manager 要不要續約', ''), true);
    assert.equal(isWaiting('庫存卡', '待確認 悠遊卡什麼時候出貨\n其他內容'), true);
    assert.equal(isWaiting('API 開通', '等 Adam 回覆'), true);
    assert.equal(isWaiting('API 開通', '其他內容\n等 Adam 回覆'), false, 'a later line does not count');
    assert.equal(isWaiting('一般記憶', '內容'), false);
    assert.ok(new RegExp(WAITING_REGEX).test('待執行 下個月再跑'));
  });
});
