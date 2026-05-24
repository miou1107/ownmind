/**
 * OwnMind Context Blob Schema — 錯誤回報附帶 context 的共用 schema
 *
 * 對應 OpenSpec 提案 v1.19.14-bug-report-tool（規格 §2.11 + §六、§七）。
 *
 * 設計重點（v4.1 第三輪 Gemini 對抗審查結論）：
 *
 *   `conversation_snippets` 是聯合型別陣列：
 *
 *     (string | TruncatedMessage | TruncatedMessagesPlaceholder)[]
 *
 *   - string                       ：短訊息、原樣保留
 *   - TruncatedMessage             ：單條太大、把單條的頭尾 2KB 包成物件
 *   - TruncatedMessagesPlaceholder ：中間多條被砍、用「省略 N 條」占位
 *
 *   前後端共用這份 schema、避免反序列化錯誤（特別是 Go / Rust 等強型別語言）。
 *
 * TruncatedMessage 結構：
 *   {
 *     truncated:     true,        // 識別字（必為 true）
 *     original_size: <number>,    // 原本訊息位元組數
 *     head:          <string>,    // 前 2KB 內容
 *     tail:          <string>     // 後 2KB 內容
 *   }
 *
 * TruncatedMessagesPlaceholder 結構：
 *   {
 *     truncated_messages: <number>, // 被砍幾條
 *     summary:            <string>  // 顯示給人看的摘要文字
 *   }
 */

export const CONTEXT_BLOB_MAX_BYTES = 1024 * 1024;        // 1MB
export const CONTEXT_BLOB_MAX_MESSAGES = 50;
export const CONTEXT_BLOB_MAX_PER_MESSAGE_BYTES = 5 * 1024; // 5KB

/**
 * 判別「截斷單條訊息」物件
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
 * 判別「省略中間多條訊息」佔位物件
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
 * 判別某個項目是聯合型別裡的合法成員（string 或前兩種物件）
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
 * 驗 conversation_snippets 陣列、回 { ok, error }
 * @param {unknown} snippets
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateConversationSnippets(snippets) {
  if (!Array.isArray(snippets)) {
    return { ok: false, error: 'conversation_snippets 必須是陣列' };
  }
  for (let i = 0; i < snippets.length; i++) {
    if (!isValidSnippetItem(snippets[i])) {
      return {
        ok: false,
        error: `conversation_snippets[${i}] 型別不對：必須是字串 / TruncatedMessage / TruncatedMessagesPlaceholder`,
      };
    }
  }
  return { ok: true };
}

/**
 * 估算物件的位元組大小（用 JSON 字串長度近似）
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
 * 驗整個 context_blob 物件
 * @param {unknown} blob
 * @returns {{ok: true, size_bytes: number} | {ok: false, error: string, size_bytes?: number}}
 */
export function validateContextBlob(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
    return { ok: false, error: 'context_blob 必須是物件' };
  }

  if (blob.conversation_snippets !== undefined) {
    const snippetCheck = validateConversationSnippets(blob.conversation_snippets);
    if (!snippetCheck.ok) {
      return { ok: false, error: snippetCheck.error };
    }
    if (blob.conversation_snippets.length > CONTEXT_BLOB_MAX_MESSAGES) {
      return {
        ok: false,
        error: `訊息數超過 ${CONTEXT_BLOB_MAX_MESSAGES} 條上限（實際 ${blob.conversation_snippets.length}）`,
      };
    }
  }

  const size = estimateSize(blob);
  if (size > CONTEXT_BLOB_MAX_BYTES) {
    return {
      ok: false,
      error: `context_blob 大小超過 1MB 上限（實際 ${size} bytes）`,
      size_bytes: size,
    };
  }

  return { ok: true, size_bytes: size };
}
