/**
 * Memory sync 純函式：parse query params + build SQL。
 * Routes handler (src/routes/memory.js) 用這些拼出 delta sync endpoint。
 */

export const SYNCABLE_TYPES = Object.freeze(['iron_rule', 'project', 'feedback']);

export function parseSyncTypes(typesParam) {
  if (!typesParam) return { ok: true, types: [...SYNCABLE_TYPES] };
  const types = String(typesParam)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (types.length === 0) return { ok: true, types: [...SYNCABLE_TYPES] };
  const invalid = types.filter((t) => !SYNCABLE_TYPES.includes(t));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `types 包含不允許的值: ${invalid.join(',')}. 允許: ${SYNCABLE_TYPES.join(',')}`,
    };
  }
  return { ok: true, types };
}

export function parseSince(sinceParam) {
  if (!sinceParam) return { ok: true, since: null };
  const d = new Date(sinceParam);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, error: 'since 不是有效 ISO8601 timestamp' };
  }
  return { ok: true, since: d };
}

const SELECT_COLUMNS = 'id, type, title, content, tags, metadata, updated_at, status';

export function buildSyncQuery(userId, types, since) {
  if (since === null) {
    return {
      text: `SELECT ${SELECT_COLUMNS}
             FROM memories
             WHERE user_id = $1
               AND type = ANY($2::text[])
               AND status = 'active'
             ORDER BY updated_at DESC`,
      values: [userId, types],
    };
  }
  return {
    text: `SELECT ${SELECT_COLUMNS}
           FROM memories
           WHERE user_id = $1
             AND type = ANY($2::text[])
             AND (updated_at > $3 OR (disabled_at IS NOT NULL AND disabled_at > $3))
           ORDER BY updated_at DESC`,
    values: [userId, types, since],
  };
}
