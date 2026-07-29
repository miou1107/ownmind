import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * v1.26.39 — the admin dashboard's memory-count card always rendered 0.
 *
 * `loadStats()` fetched /export and counted with
 *   Object.values(data).forEach(arr => { if (Array.isArray(arr)) count += arr.length })
 * but the endpoint returns { exported_at, user_id, total_count, memories } where
 * `memories` is an object keyed by memory type. No top-level value is an array,
 * so the loop added nothing and the card showed 0 while the account actually
 * held 387 memories (verified live on 2026-07-29).
 *
 * The counting logic lives in the admin page's inline script, so the test pulls
 * the function out of the HTML and runs it for real against payload fixtures —
 * this checks behaviour rather than asserting on source text.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');

/** Lift countExportedMemories out of the inline script so it can be executed. */
function loadCounter() {
  const match = html.match(/function countExportedMemories\(data\)\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(match, 'countExportedMemories not found in the admin inline script');
  // eslint-disable-next-line no-new-func
  return new Function(`${match[0]}; return countExportedMemories;`)();
}

describe('countExportedMemories', () => {
  it('reads total_count from the current /export payload', () => {
    const count = loadCounter();
    assert.equal(count({
      exported_at: '2026-07-29T09:00:00.000Z',
      user_id: 1,
      total_count: 387,
      memories: { iron_rule: [{}, {}], project: [{}] },
    }), 387);
  });

  it('does not fall back to the grouped object when total_count is present', () => {
    // The regression: grouped lengths (3) must not win over the authoritative 387.
    const count = loadCounter();
    assert.equal(count({ total_count: 387, memories: { a: [{}, {}], b: [{}] } }), 387);
  });

  it('sums the grouped object when total_count is absent', () => {
    const count = loadCounter();
    assert.equal(count({ memories: { iron_rule: [{}, {}, {}], project: [{}, {}] } }), 5);
  });

  it('still handles a legacy flat payload of type -> array', () => {
    const count = loadCounter();
    assert.equal(count({ iron_rule: [{}, {}], project: [{}] }), 3);
  });

  it('counts a flat array of memories', () => {
    // Object.values on an array yields the rows themselves, none of which is an
    // array — the same silent-zero shape as the original bug.
    const count = loadCounter();
    assert.equal(count({ memories: [{}, {}, {}] }), 3);
  });

  it('counts zero rather than throwing on empty or malformed payloads', () => {
    const count = loadCounter();
    assert.equal(count({}), 0);
    assert.equal(count({ memories: {} }), 0);
    assert.equal(count(null), 0);
    assert.equal(count(undefined), 0);
    assert.equal(count('nope'), 0);
    assert.equal(count({ total_count: 'not-a-number', memories: { a: [{}] } }), 1);
  });

  it('ignores a non-finite total_count', () => {
    const count = loadCounter();
    assert.equal(count({ total_count: NaN, memories: { a: [{}] } }), 1);
    assert.equal(count({ total_count: Infinity, memories: { a: [{}] } }), 1);
  });

  it('treats an explicit zero as a real count, not a missing value', () => {
    // The grouped object deliberately holds rows: a `total_count > 0` style
    // guard would fall through and answer 2, so this fixture can tell a correct
    // implementation from that plausible-looking mistake.
    const count = loadCounter();
    assert.equal(count({ total_count: 0, memories: { iron_rule: [{}, {}] } }), 0);
  });
});

describe('loadStats wiring', () => {
  it('writes the count into the memory card, not some other element', () => {
    // Pinning the whole assignment: asserting only that the helper is called
    // would stay green if the result were written to the wrong element, and
    // wiring is exactly where this bug lived.
    const body = html.match(/async function loadStats\(\)\s*\{[\s\S]*?\n {2}\}/);
    assert.ok(body, 'loadStats not found');
    assert.match(
      body[0],
      /getElementById\('totalMemories'\)\.textContent = countExportedMemories\(data\)/
    );
    assert.doesNotMatch(body[0], /Object\.values\(data\)\.forEach/);
  });

  it('treats a non-OK response as a failure instead of counting its error body', () => {
    // A 401 or 500 still parses as JSON, so without this the card would render
    // a confident 0 — the very symptom this change exists to remove.
    const body = html.match(/async function loadStats\(\)\s*\{[\s\S]*?\n {2}\}/);
    assert.match(body[0], /if \(!res\.ok\) throw/);
  });

  it('keeps the failure fallback that renders a dash', () => {
    const body = html.match(/async function loadStats\(\)\s*\{[\s\S]*?\n {2}\}/);
    assert.match(body[0], /catch[\s\S]*'-'/);
  });

  it('labels the card with both whose count it is and which rows it covers', () => {
    // /export is per-account and filters status = 'active'. Sitting next to
    // 使用者總數 (all users), an unqualified 記憶總數 reads as system-wide; and
    // the stats tab already uses 記憶總數 for a figure that includes disabled
    // rows (418 vs 387), so reusing the word here would contradict it.
    const card = html.match(/id="totalMemories"[\s\S]{0,200}?<\/div>\s*<\/div>/);
    assert.ok(card, 'totalMemories card not found');
    assert.match(card[0], /我的記憶（啟用中）/);
    assert.doesNotMatch(card[0], /總數/);
  });
});
