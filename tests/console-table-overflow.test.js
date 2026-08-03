// v1.26.51 — console table wrappers must scroll horizontally, not clip.
//
// Found by the production browser check for v1.26.51, on the page this stage
// built. The pattern
//
//   <div className="... rounded-xl overflow-hidden shadow-sm">
//     <table className="w-full text-sm"> ... 8 columns ... </table>
//   </div>
//
// clips instead of scrolling. Measured on kkvin.com at a 968px viewport: the
// wrapper's clientWidth was 662 while the table's scrollWidth was 841, so the
// last two columns (建立時間 and 操作) were cut off with no way to reach them.
// The 操作 column is where the only action button on 錯誤回報 lives, so the
// detail modal was unreachable — the page rendered but could not be used.
//
// This is a source-text assertion, which this repo is otherwise sceptical of.
// It earns its place here for the same reason the /admin mount assertion in
// legacy-console-manifest.test.js does: node --test cannot render JSX, so the
// only executable guard available is over the class list itself, and the class
// list IS the whole behaviour in this case. A rendering test would be better;
// there is no rendering environment.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pagesRoot = join(repoRoot, 'client/src/pages');

/** Every .jsx under client/src/pages, recursively. */
function pageFiles(dir = pagesRoot, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) pageFiles(full, acc);
    else if (entry.name.endsWith('.jsx')) acc.push(full);
  }
  return acc;
}

/**
 * The console's table-card idiom: a bordered, rounded, shadowed div wrapping a
 * table. Every list view in the console uses it.
 */
const TABLE_CARD = /border-slate-200[^"]*rounded-xl/;

/**
 * Wrapper <div>s that contain a <table>, filtered to the table-card idiom.
 *
 * Deliberately crude: find each `<table`, walk backwards to the nearest
 * `<div className="..."`, and report that class list. Two known limits, both
 * accepted rather than fixed by parsing JSX:
 *
 *   - The nearest preceding div is not always the real parent. A layout table
 *     inside a modal, for instance, matched an unrelated error banner. The
 *     TABLE_CARD filter removes that noise, at the cost of only guarding
 *     tables that use the idiom — a list view written with different classes
 *     escapes this check entirely.
 *   - A wrapper more than one level up is missed.
 *
 * The guard is therefore a floor, not a proof. It is still the thing that
 * would have caught v1.26.51's clipped 操作 column before deploy.
 */
function tableWrapperClasses(source) {
  const out = [];
  let idx = source.indexOf('<table');
  while (idx !== -1) {
    const before = source.slice(0, idx);
    const divIdx = before.lastIndexOf('<div className="');
    if (divIdx !== -1) {
      const start = divIdx + '<div className="'.length;
      const end = source.indexOf('"', start);
      if (end !== -1) {
        const classes = source.slice(start, end);
        if (TABLE_CARD.test(classes)) out.push(classes);
      }
    }
    idx = source.indexOf('<table', idx + 1);
  }
  return out;
}

describe('console tables scroll horizontally instead of clipping', () => {
  it('no table wrapper clips its overflow', () => {
    // `overflow-hidden` on a wrapper whose table is wider than the viewport
    // makes the rightmost columns permanently unreachable — no scrollbar, no
    // drag, nothing. Any table that can be wide needs `overflow-x-auto`.
    const offenders = [];
    for (const file of pageFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const classes of tableWrapperClasses(source)) {
        if (/\boverflow-hidden\b/.test(classes)) {
          offenders.push(`${file.slice(repoRoot.length + 1)} → "${classes}"`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these table wrappers clip instead of scroll:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('every table wrapper makes an explicit overflow choice', () => {
    // The positive half. Without it, deleting `overflow-hidden` and putting
    // nothing in its place would pass the test above by saying nothing at all.
    //
    // Two choices are legitimate, and which one is right depends on the table:
    //
    //   overflow-x-auto    the default — wide tables scroll inside the card
    //   overflow-visible   for a table whose rows contain a popover that has
    //                      to escape the card. TeamPage's RowMenu dropdown is
    //                      the only case today; scrolling there would clip the
    //                      menu instead of the columns, trading one unreachable
    //                      control for another
    const missing = [];
    for (const file of pageFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const classes of tableWrapperClasses(source)) {
        if (!/\boverflow-(x-auto|visible)\b/.test(classes)) {
          missing.push(`${file.slice(repoRoot.length + 1)} → "${classes}"`);
        }
      }
    }
    assert.deepEqual(
      missing,
      [],
      `these table wrappers declare no overflow behaviour:\n  ${missing.join('\n  ')}`,
    );
  });

  it('the helper actually finds the wrappers it claims to check', () => {
    // Guards against the failure mode where a refactor changes the JSX shape,
    // tableWrapperClasses silently returns [], and both tests above go green
    // by finding nothing at all.
    let found = 0;
    for (const file of pageFiles()) {
      found += tableWrapperClasses(readFileSync(file, 'utf8')).length;
    }
    assert.ok(found >= 10, `expected to find at least 10 table wrappers, found ${found}`);
  });
});
