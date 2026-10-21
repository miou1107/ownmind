/**
 * The server's answer to "does this read like a memory I already have" (v1.33.0).
 *
 * No model runs here. pg_trgm's trigram similarity over `lower(title || ' ' || content)`
 * is enough to catch the two things a save-time check must catch: the same text saved
 * twice (exact) and a near rewrite the AI should update instead of adding to (related).
 * The AI, which does have a model, reads the `similar` list and decides. See the proposal:
 * the thresholds are constants with tests that show the worst case, two deploy checklists
 * that differ only in a host name land in `similar` and never in `exact`.
 */

/** At or above this the text is the same memory; the server refuses to insert a second. */
export const SIMILARITY_EXACT = 0.98;
/** At or above this the memory is returned to the AI as related; the AI decides. */
export const SIMILARITY_RELATED = 0.45;
/** Pairs at or above this are listed on the monthly card as merge candidates. */
export const SIMILARITY_CANDIDATE = 0.6;
/**
 * Two lessons at or above this are the same lesson learned twice. Compared on all three
 * answers (stuck, fix, next_time): a Chinese paraphrase of the same problem scored 0.54 on
 * stuck+fix alone and 0.62 on all three (measured 2026-10-21), while unrelated lessons
 * score 0.0, so 0.5 keeps the margin on both sides.
 */
export const LESSON_REPEAT = 0.5;

/** How much of a related memory's content travels back to the AI. */
export const EXCERPT_LENGTH = 160;

/**
 * The same text the GIN index and the SQL compare: lower-cased, whitespace collapsed.
 * @param {string|null|undefined} title
 * @param {string|null|undefined} content
 */
export function normalizeForSimilarity(title, content) {
  return [title, content]
    .filter((s) => typeof s === 'string' && s.length > 0)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first EXCERPT_LENGTH characters of a memory's content, for the relay. */
export function excerptOf(content) {
  const text = typeof content === 'string' ? content.replace(/\s+/g, ' ').trim() : '';
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text;
}

/**
 * The active memories of the same user, type and test flag that read like this one.
 *
 * @param {(sql: string, params: unknown[]) => Promise<{rows: object[]}>} query
 * @param {{userId: number, type: string, title: string, content: string, isTest?: boolean}} opts
 * @returns {Promise<{exact: object|null, similar: Array<{id: number, title: string, similarity: number, excerpt: string}>}>}
 */
export async function findSimilarMemories(query, { userId, type, title, content, isTest = false }) {
  const text = normalizeForSimilarity(title, content);
  const r = await query(
    `SELECT id, title, content,
            similarity(lower(title || ' ' || content), $4) AS similarity
       FROM memories
      WHERE user_id = $1 AND type = $2 AND is_test = $3 AND status = 'active'
        AND similarity(lower(title || ' ' || content), $4) >= $5
      ORDER BY similarity DESC, id ASC
      LIMIT 3`,
    [userId, type, Boolean(isTest), text, SIMILARITY_RELATED],
  );
  const rows = r.rows.map((row) => ({ ...row, similarity: Number(row.similarity) }));
  const exact = rows.find((row) => row.similarity >= SIMILARITY_EXACT) || null;
  return {
    exact,
    similar: rows.map((row) => ({
      id: row.id, title: row.title, similarity: row.similarity, excerpt: excerptOf(row.content),
    })),
  };
}

/** The words that say a project memory describes something that has ended. */
export const CONCLUDED_MARKERS = Object.freeze(['已過時', '已結案', '已完成', '已發', '已合併', '已關單']);

/**
 * One regex string for both Postgres (`~`) and JavaScript, so the SQL candidate list and
 * the marker the card shows cannot disagree. A marker counts at the start of the title
 * (followed by its bracket, a space, a colon or the end) or at the very end, with or
 * without 【】. Postgres ARE and JavaScript both read `\s`, `|`, `?` and `$` the same way.
 */
const MARKER_ALTERNATION = CONCLUDED_MARKERS.join('|');
export const CONCLUDED_TITLE_REGEX =
  `^(?:【(${MARKER_ALTERNATION})】|(${MARKER_ALTERNATION})(?:\\s|$|:|：))|(${MARKER_ALTERNATION})】?$`;

const concludedRe = new RegExp(CONCLUDED_TITLE_REGEX);

/** @returns {string|null} the marker a title carries, or null */
export function concludedMarker(title) {
  const m = concludedRe.exec(typeof title === 'string' ? title : '');
  return m ? (m[1] || m[2] || m[3]) : null;
}

/** A memory whose title or first line says it waits on a decision, a check, or a reply. */
export const WAITING_REGEX = '待決定|待確認|待執行|等.{0,12}回覆';
const waitingRe = new RegExp(WAITING_REGEX);

export function isWaiting(title, content) {
  const firstLine = typeof content === 'string' ? content.split('\n')[0] : '';
  return waitingRe.test(typeof title === 'string' ? title : '') || waitingRe.test(firstLine);
}
