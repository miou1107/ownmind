import { test } from 'node:test';
import assert from 'node:assert';
import { parseStandardMarkdown } from '../../src/utils/md-parser.js';

test('parseStandardMarkdown should correctly split by headers up to H3', (t) => {
  const md = `# H1 Title
Intro...
## H2 Sub
Detail...
### H3 Deep
Inner...
#### H4 Too Deep
Still Inner...
# H1 Back`;

  const chunks = parseStandardMarkdown(md, 3);
  
  // H1
  assert.strictEqual(chunks[0].title, 'H1 Title');
  assert.strictEqual(chunks[0].content, 'Intro...');

  // H2
  assert.strictEqual(chunks[1].title, 'H1 Title > H2 Sub');
  assert.strictEqual(chunks[1].content, 'Detail...');

  // H3
  assert.strictEqual(chunks[2].title, 'H1 Title > H2 Sub > H3 Deep');
  // Should include H4 because H4 > maxDepth
  assert.ok(chunks[2].content.includes('Inner...'));
  assert.ok(chunks[2].content.includes('#### H4 Too Deep'));
  assert.ok(chunks[2].content.includes('Still Inner...'));

  // Another H1
  assert.strictEqual(chunks[3].title, 'H1 Back');
});

test('parseStandardMarkdown should handle empty content', (t) => {
  const chunks = parseStandardMarkdown('', 3);
  assert.strictEqual(chunks.length, 0);
});

test('parseStandardMarkdown should handle non-ASCII characters (Chinese)', (t) => {
  const md = `# 中文標題
內容...
## 次級測試
詳細。`;
  const chunks = parseStandardMarkdown(md, 3);
  assert.strictEqual(chunks[0].title, '中文標題');
  assert.strictEqual(chunks[1].title, '中文標題 > 次級測試');
});

test('parseStandardMarkdown should handle consecutive headers without body', (t) => {
  const md = `# H1
## H2
### H3
Content here`;
  const chunks = parseStandardMarkdown(md, 3);
  assert.strictEqual(chunks.length, 3);
  assert.strictEqual(chunks[0].content, '');
  assert.strictEqual(chunks[1].content, '');
  assert.strictEqual(chunks[2].content, 'Content here');
});

test('parseStandardMarkdown should handle plain text before first header', (t) => {
  const md = `This is some preamble.
# First Header
Body...`;
  const chunks = parseStandardMarkdown(md, 3);
  // 現行邏輯：前導文字會被切為一個 title 為空字串的 chunk
  assert.strictEqual(chunks[0].title, '');
  assert.strictEqual(chunks[0].content, 'This is some preamble.');
  assert.strictEqual(chunks[1].title, 'First Header');
});

test('parseStandardMarkdown should handle complex interleaved nesting', (t) => {
  const md = `# H1a
## H2a
# H1b
## H2b
### H3b
#### H4b`;
  const chunks = parseStandardMarkdown(md, 3);
  assert.strictEqual(chunks.length, 5);
  assert.strictEqual(chunks[4].title, 'H1b > H2b > H3b');
  assert.ok(chunks[4].content.includes('#### H4b'));
});
