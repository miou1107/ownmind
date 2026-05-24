import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_BLOB_MAX_BYTES,
  CONTEXT_BLOB_MAX_MESSAGES,
  CONTEXT_BLOB_MAX_PER_MESSAGE_BYTES,
  isTruncatedMessage,
  isTruncatedMessagesPlaceholder,
  validateContextBlob,
  validateConversationSnippets,
} from '../shared/context-blob-schema.js';

// ============================================================
// 常數
// ============================================================

test('上限常數：1MB / 50 條 / 每條 5KB', () => {
  assert.equal(CONTEXT_BLOB_MAX_BYTES, 1024 * 1024);
  assert.equal(CONTEXT_BLOB_MAX_MESSAGES, 50);
  assert.equal(CONTEXT_BLOB_MAX_PER_MESSAGE_BYTES, 5 * 1024);
});

// ============================================================
// isTruncatedMessage：判別「截斷單條訊息」物件
// ============================================================

test('isTruncatedMessage 對完整的截斷物件回 true', () => {
  assert.equal(
    isTruncatedMessage({
      truncated: true,
      original_size: 102400,
      head: 'hello',
      tail: 'world',
    }),
    true
  );
});

test('isTruncatedMessage 對純字串回 false', () => {
  assert.equal(isTruncatedMessage('plain string'), false);
});

test('isTruncatedMessage 對 null / undefined / 數字回 false', () => {
  assert.equal(isTruncatedMessage(null), false);
  assert.equal(isTruncatedMessage(undefined), false);
  assert.equal(isTruncatedMessage(123), false);
});

test('isTruncatedMessage 對欄位缺漏的物件回 false', () => {
  assert.equal(isTruncatedMessage({ truncated: true }), false);
  assert.equal(isTruncatedMessage({ truncated: true, head: 'h' }), false);
  assert.equal(isTruncatedMessage({ truncated: false, head: 'h', tail: 't', original_size: 1 }), false);
});

// ============================================================
// isTruncatedMessagesPlaceholder：判別「省略中間多條訊息」佔位
// ============================================================

test('isTruncatedMessagesPlaceholder 對完整佔位物件回 true', () => {
  assert.equal(
    isTruncatedMessagesPlaceholder({
      truncated_messages: 30,
      summary: '已省略 30 條中間訊息',
    }),
    true
  );
});

test('isTruncatedMessagesPlaceholder 對純字串回 false', () => {
  assert.equal(isTruncatedMessagesPlaceholder('hello'), false);
});

test('isTruncatedMessagesPlaceholder 跟 isTruncatedMessage 互斥', () => {
  const placeholder = { truncated_messages: 30, summary: 'x' };
  const single = { truncated: true, original_size: 1000, head: 'h', tail: 't' };
  assert.equal(isTruncatedMessagesPlaceholder(placeholder), true);
  assert.equal(isTruncatedMessage(placeholder), false);
  assert.equal(isTruncatedMessage(single), true);
  assert.equal(isTruncatedMessagesPlaceholder(single), false);
});

// ============================================================
// validateConversationSnippets：驗陣列內每筆是合法型別
// ============================================================

test('validateConversationSnippets：純字串陣列合法', () => {
  const result = validateConversationSnippets(['hello', 'world']);
  assert.equal(result.ok, true);
});

test('validateConversationSnippets：混合字串 + 截斷物件合法（聯合型別）', () => {
  const result = validateConversationSnippets([
    'short',
    { truncated: true, original_size: 100000, head: 'h', tail: 't' },
    'short again',
    { truncated_messages: 5, summary: '已省略 5 條' },
  ]);
  assert.equal(result.ok, true);
});

test('validateConversationSnippets：含數字陣列項回 ok=false', () => {
  const result = validateConversationSnippets(['ok', 123]);
  assert.equal(result.ok, false);
  assert.match(result.error, /型別/);
});

test('validateConversationSnippets：含 null 項回 ok=false', () => {
  const result = validateConversationSnippets(['ok', null]);
  assert.equal(result.ok, false);
});

test('validateConversationSnippets：非陣列回 ok=false', () => {
  assert.equal(validateConversationSnippets('not array').ok, false);
  assert.equal(validateConversationSnippets({}).ok, false);
  assert.equal(validateConversationSnippets(null).ok, false);
});

// ============================================================
// validateContextBlob：整個 context_blob 物件驗證
// ============================================================

test('validateContextBlob：完整合法物件', () => {
  const result = validateContextBlob({
    conversation_snippets: ['hello', 'world'],
    env: { os: 'darwin', node: 'v20' },
    project_path: '/Users/vin/foo',
  });
  assert.equal(result.ok, true);
});

test('validateContextBlob：conversation_snippets 缺漏仍合法（選填）', () => {
  const result = validateContextBlob({
    env: { os: 'darwin' },
  });
  assert.equal(result.ok, true);
});

test('validateContextBlob：conversation_snippets 不合法 → ok=false', () => {
  const result = validateContextBlob({
    conversation_snippets: [123],
  });
  assert.equal(result.ok, false);
});

test('validateContextBlob：超過 1MB → ok=false + size_bytes 回報', () => {
  const big = 'x'.repeat(CONTEXT_BLOB_MAX_BYTES + 1);
  const result = validateContextBlob({
    conversation_snippets: [big],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /1MB|大小|超過/);
});

test('validateContextBlob：超過 50 條訊息 → ok=false', () => {
  const result = validateContextBlob({
    conversation_snippets: new Array(51).fill('msg'),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /50|訊息數/);
});

test('validateContextBlob：非物件回 ok=false', () => {
  assert.equal(validateContextBlob('string').ok, false);
  assert.equal(validateContextBlob(null).ok, false);
  assert.equal(validateContextBlob([]).ok, false);
});
