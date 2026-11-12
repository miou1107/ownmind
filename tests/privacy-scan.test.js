// scripts/privacy-scan.js: the lines a commit adds are checked against a private term list and
// for real e-mail addresses. Every value here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedLines, scanLines } from '../scripts/privacy-scan.js';

test('addedLines: only added lines, with the new file line numbers', () => {
  const diff = [
    'diff --git a/x.md b/x.md',
    '--- a/x.md',
    '+++ b/x.md',
    '@@ -3,0 +4,2 @@',
    '+first',
    '+second',
    '@@ -10 +12 @@',
    '-old',
    '+new',
  ].join('\n');
  assert.deepEqual(addedLines(diff), [
    { file: 'x.md', line: 4, text: 'first' },
    { file: 'x.md', line: 5, text: 'second' },
    { file: 'x.md', line: 12, text: 'new' },
  ]);
});

test('scanLines: a listed term matches case-insensitively and the hit never carries the text', () => {
  const hits = scanLines([{ file: 'a.js', line: 3, text: 'Assigned to Jordan Example-Person' }], ['jordan example-person']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'a.js');
  assert.equal(hits[0].line, 3);
  assert.ok(!JSON.stringify(hits).toLowerCase().includes('jordan'));
});

test('scanLines: placeholder e-mail domains pass, any other domain is a hit', () => {
  const ok = scanLines([
    { file: 'a', line: 1, text: 'member-1@example.com and 123+bot@users.noreply.github.com' },
    { file: 'a', line: 2, text: 'Co-Authored-By: Claude <noreply@anthropic.com>' },
  ], []);
  assert.equal(ok.length, 0);
  const bad = scanLines([{ file: 'a', line: 9, text: `mail someone@${'realcompany'}.co` }], []);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].line, 9);
});

test('scanLines: a Latin term matches whole words only', () => {
  assert.equal(scanLines([{ file: 'a', line: 1, text: 'a generic helper' }], ['Eri']).length, 0);
  assert.equal(scanLines([{ file: 'a', line: 1, text: 'a generic helper' }], ['generic']).length, 1);
  assert.equal(scanLines([{ file: 'a', line: 1, text: 'see LAPTOP-ABC123.' }], ['laptop-abc123']).length, 1);
});

test('addedLines: an added line that starts with "++ " is content, not a file header', () => {
  const diff = ['--- a/x.md', '+++ b/x.md', '@@ -0,0 +1,2 @@', '+++ not a header', '+second'].join('\n');
  assert.deepEqual(addedLines(diff).map((l) => [l.file, l.line, l.text]), [['x.md', 1, '++ not a header'], ['x.md', 2, 'second']]);
});
