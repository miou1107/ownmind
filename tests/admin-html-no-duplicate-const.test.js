import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, '..', 'legacy', 'admin-v1.26', 'index.html');
const html = readFileSync(htmlPath, 'utf8');

/**
 * v1.19.16 hotfix: the inline JS in admin HTML must not contain duplicate `const`
 * declarations within the same function — otherwise the whole script fails to parse
 * and every function (including login) becomes unreachable → admin cannot sign in.
 *
 * Trigger: when v1.19.0 (commit 5ffc646) introduced the iron-rule tier upgrade helper,
 * iruUpdateTier had `const cached` twice (lines 1926 and 1948), which is a clear
 * JavaScript SyntaxError. Browser caches kept some users from hitting it until reload
 * after the v1.19.14 / v1.19.15 deploy uncovered the bug.
 *
 * Text-based check: count `const cached` occurrences inside iruUpdateTier and require ≤ 1.
 */

test('iruUpdateTier must not redeclare const cached', () => {
  // Grab the whole iruUpdateTier function (from its declaration to the next async function / function).
  const match = html.match(
    /async function iruUpdateTier\([^)]*\)\s*\{([\s\S]*?)^\s{2}\}/m
  );
  assert.ok(match, 'iruUpdateTier function not found');

  const body = match[1];
  const occurrences = (body.match(/\bconst\s+cached\b/g) || []).length;
  assert.equal(
    occurrences,
    1,
    `iruUpdateTier should declare const cached exactly once; actual ${occurrences} (duplicates cause a SyntaxError and break admin login)`
  );
});

// Note: a "scan every function" check was attempted but const is legal with the same name
// in different block scopes (e.g. an if/else with `const t` in each branch), so the broad
// check produced many false positives. Keeping the precise iruUpdateTier check covers the
// real bug. If another duplicate shows up later, add it as a dedicated case.

// ============================================================
// v1.19.17 hotfix: modal-overlay shows via the .active class, not .show
// ============================================================
// Reason: the CSS rule is `.modal-overlay.active { display: flex; }`, so classList
// operations must use 'active'. Using 'show' means the modal never shows — clicks on
// "view" / "review" buttons do nothing and the UX breaks.

test('modal classList must use active, not show', () => {
  // Existing CSS rule: only .modal-overlay.active is displayed.
  assert.match(
    html,
    /\.modal-overlay\.active\s*\{\s*display:\s*flex/,
    'CSS should define .modal-overlay.active so the modal is displayed'
  );

  // There must be no classList.add('show') / .remove('show') anywhere (would target a dead modal).
  const wrongAdd = (html.match(/classList\.add\(\s*['"]show['"]\s*\)/g) || []).length;
  const wrongRemove = (html.match(/classList\.remove\(\s*['"]show['"]\s*\)/g) || []).length;
  assert.equal(
    wrongAdd + wrongRemove,
    0,
    `found classList.add/remove('show') ${wrongAdd + wrongRemove} times; all must switch to 'active' (CSS rule uses .active)`
  );
});
