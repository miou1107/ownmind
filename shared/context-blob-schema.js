/**
 * OwnMind Context Blob Schema — shared schema for the context attached to
 * bug reports.
 *
 * Corresponds to OpenSpec proposal v1.19.14-bug-report-tool (§2.11 + §VI, §VII).
 *
 * Design (v4.1, third Gemini adversarial review):
 *
 *   `conversation_snippets` is a union-type array:
 *
 *     (string | TruncatedMessage | TruncatedMessagesPlaceholder)[]
 *
 *   - string                       : short message, kept as-is
 *   - TruncatedMessage             : oversized single message; wraps the
 *                                    head + tail 2KB into an object
 *   - TruncatedMessagesPlaceholder : many messages dropped from the middle;
 *                                    placeholder reading "N messages omitted"
 *
 *   Front- and back-end share this schema to avoid deserialization errors
 *   (especially in strongly-typed languages like Go / Rust).
 *
 * TruncatedMessage shape:
 *   {
 *     truncated:     true,        // discriminator (must be true)
 *     original_size: <number>,    // original size in bytes
 *     head:          <string>,    // first 2KB
 *     tail:          <string>     // last 2KB
 *   }
 *
 * TruncatedMessagesPlaceholder shape:
 *   {
 *     truncated_messages: <number>, // how many messages were dropped
 *     summary:            <string>  // human-readable summary
 *   }
 */

export const CONTEXT_BLOB_MAX_BYTES = 1024 * 1024;        // 1MB
export const CONTEXT_BLOB_MAX_MESSAGES = 50;
export const CONTEXT_BLOB_MAX_PER_MESSAGE_BYTES = 5 * 1024; // 5KB

/**
 * Discriminate a "truncated single message" object.
 * @param {unknown} item
 * @returns {boolean}
 */
export function isTruncatedMessage(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  return (
    item.truncated === true &&
    typeof item.original_size === 'number' &&
    typeof item.head === 'string' &&
    typeof item.tail === 'string'
  );
}

/**
 * Discriminate an "N middle messages omitted" placeholder.
 * @param {unknown} item
 * @returns {boolean}
 */
export function isTruncatedMessagesPlaceholder(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  return (
    typeof item.truncated_messages === 'number' &&
    typeof item.summary === 'string'
  );
}

/**
 * Check that an item is a valid member of the snippet union type (string
 * or one of the two object shapes above).
 * @param {unknown} item
 * @returns {boolean}
 */
function isValidSnippetItem(item) {
  return (
    typeof item === 'string' ||
    isTruncatedMessage(item) ||
    isTruncatedMessagesPlaceholder(item)
  );
}

/**
 * Validate the conversation_snippets array; returns { ok, error }.
 * @param {unknown} snippets
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateConversationSnippets(snippets) {
  if (!Array.isArray(snippets)) {
    return { ok: false, error: 'conversation_snippets must be an array' };
  }
  for (let i = 0; i < snippets.length; i++) {
    if (!isValidSnippetItem(snippets[i])) {
      return {
        ok: false,
        error: `conversation_snippets[${i}] has wrong type: must be a string / TruncatedMessage / TruncatedMessagesPlaceholder`,
      };
    }
  }
  return { ok: true };
}

/**
 * Estimate an object's byte size (approximated via JSON string length).
 * @param {unknown} obj
 * @returns {number}
 */
function estimateSize(obj) {
  try {
    return Buffer.byteLength(JSON.stringify(obj), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Validate the whole context_blob object.
 * @param {unknown} blob
 * @returns {{ok: true, size_bytes: number} | {ok: false, error: string, size_bytes?: number}}
 */
export function validateContextBlob(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
    return { ok: false, error: 'context_blob must be an object' };
  }

  if (blob.conversation_snippets !== undefined) {
    const snippetCheck = validateConversationSnippets(blob.conversation_snippets);
    if (!snippetCheck.ok) {
      return { ok: false, error: snippetCheck.error };
    }
    if (blob.conversation_snippets.length > CONTEXT_BLOB_MAX_MESSAGES) {
      return {
        ok: false,
        error: `message count exceeds the cap of ${CONTEXT_BLOB_MAX_MESSAGES} (actual ${blob.conversation_snippets.length})`,
      };
    }
  }

  const size = estimateSize(blob);
  if (size > CONTEXT_BLOB_MAX_BYTES) {
    return {
      ok: false,
      error: `context_blob size exceeds the 1MB cap (actual ${size} bytes)`,
      size_bytes: size,
    };
  }

  return { ok: true, size_bytes: size };
}
