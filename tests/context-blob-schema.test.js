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
// Constants
// ============================================================

test('limit constants: 1MB / 50 messages / 5KB per message', () => {
  assert.equal(CONTEXT_BLOB_MAX_BYTES, 1024 * 1024);
  assert.equal(CONTEXT_BLOB_MAX_MESSAGES, 50);
  assert.equal(CONTEXT_BLOB_MAX_PER_MESSAGE_BYTES, 5 * 1024);
});

// ============================================================
// isTruncatedMessage: detect the "single truncated message" object
// ============================================================

test('isTruncatedMessage returns true for a fully-formed truncation object', () => {
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

test('isTruncatedMessage returns false for a plain string', () => {
  assert.equal(isTruncatedMessage('plain string'), false);
});

test('isTruncatedMessage returns false for null / undefined / number', () => {
  assert.equal(isTruncatedMessage(null), false);
  assert.equal(isTruncatedMessage(undefined), false);
  assert.equal(isTruncatedMessage(123), false);
});

test('isTruncatedMessage returns false for objects with missing fields', () => {
  assert.equal(isTruncatedMessage({ truncated: true }), false);
  assert.equal(isTruncatedMessage({ truncated: true, head: 'h' }), false);
  assert.equal(isTruncatedMessage({ truncated: false, head: 'h', tail: 't', original_size: 1 }), false);
});

// ============================================================
// isTruncatedMessagesPlaceholder: detect the "elided middle messages" placeholder
// ============================================================

test('isTruncatedMessagesPlaceholder returns true for a fully-formed placeholder object', () => {
  assert.equal(
    isTruncatedMessagesPlaceholder({
      truncated_messages: 30,
      summary: '已省略 30 條中間訊息',
    }),
    true
  );
});

test('isTruncatedMessagesPlaceholder returns false for a plain string', () => {
  assert.equal(isTruncatedMessagesPlaceholder('hello'), false);
});

test('isTruncatedMessagesPlaceholder and isTruncatedMessage are mutually exclusive', () => {
  const placeholder = { truncated_messages: 30, summary: 'x' };
  const single = { truncated: true, original_size: 1000, head: 'h', tail: 't' };
  assert.equal(isTruncatedMessagesPlaceholder(placeholder), true);
  assert.equal(isTruncatedMessage(placeholder), false);
  assert.equal(isTruncatedMessage(single), true);
  assert.equal(isTruncatedMessagesPlaceholder(single), false);
});

// ============================================================
// validateConversationSnippets: verify each array item is a valid type
// ============================================================

test('validateConversationSnippets: pure string array is valid', () => {
  const result = validateConversationSnippets(['hello', 'world']);
  assert.equal(result.ok, true);
});

test('validateConversationSnippets: mixed string + truncation object is valid (union type)', () => {
  const result = validateConversationSnippets([
    'short',
    { truncated: true, original_size: 100000, head: 'h', tail: 't' },
    'short again',
    { truncated_messages: 5, summary: '已省略 5 條' },
  ]);
  assert.equal(result.ok, true);
});

test('validateConversationSnippets: array containing a number returns ok=false', () => {
  const result = validateConversationSnippets(['ok', 123]);
  assert.equal(result.ok, false);
  assert.match(result.error, /型別|wrong type/);
});

test('validateConversationSnippets: array containing null returns ok=false', () => {
  const result = validateConversationSnippets(['ok', null]);
  assert.equal(result.ok, false);
});

test('validateConversationSnippets: non-array returns ok=false', () => {
  assert.equal(validateConversationSnippets('not array').ok, false);
  assert.equal(validateConversationSnippets({}).ok, false);
  assert.equal(validateConversationSnippets(null).ok, false);
});

// ============================================================
// validateContextBlob: validate the full context_blob object
// ============================================================

test('validateContextBlob: fully valid object', () => {
  const result = validateContextBlob({
    conversation_snippets: ['hello', 'world'],
    env: { os: 'darwin', node: 'v20' },
    project_path: '/Users/vin/foo',
  });
  assert.equal(result.ok, true);
});

test('validateContextBlob: missing conversation_snippets is still valid (optional)', () => {
  const result = validateContextBlob({
    env: { os: 'darwin' },
  });
  assert.equal(result.ok, true);
});

test('validateContextBlob: invalid conversation_snippets → ok=false', () => {
  const result = validateContextBlob({
    conversation_snippets: [123],
  });
  assert.equal(result.ok, false);
});

test('validateContextBlob: over 1MB → ok=false + size_bytes reported', () => {
  const big = 'x'.repeat(CONTEXT_BLOB_MAX_BYTES + 1);
  const result = validateContextBlob({
    conversation_snippets: [big],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /1MB|大小|超過/);
});

test('validateContextBlob: over 50 messages → ok=false', () => {
  const result = validateContextBlob({
    conversation_snippets: new Array(51).fill('msg'),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /50|訊息數/);
});

test('validateContextBlob: non-object returns ok=false', () => {
  assert.equal(validateContextBlob('string').ok, false);
  assert.equal(validateContextBlob(null).ok, false);
  assert.equal(validateContextBlob([]).ok, false);
});
