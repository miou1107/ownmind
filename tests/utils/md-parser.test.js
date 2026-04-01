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
