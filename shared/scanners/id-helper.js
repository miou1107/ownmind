/**
 * shared/scanners/id-helper.js
 *
 * Codex 專用 fingerprint helper。**Client scanner 與 server ingestion 共用此檔**，
 * 任一方都應能從同一 canonical material 算出同一 message_id。
 *
 * 關鍵原則（spec S4 / D10 / D13）：
 *   - hash 順序：先 canonicalize，再 hash。絕不用 raw client 輸入直接 hash。
 *   - 完整 sha256（64 hex），不截斷 — 截斷碰撞會讓 ON CONFLICT DO NOTHING 丟資料。
 *   - 必填欄位缺失 → throw（上層決定 client reject 或 server 400）。不做 null→0 自動填補。
 *
 * Claude Code / OpenCode 都有 native id，不經此 helper。
 */

import crypto from 'crypto';

export const CODEX_MATERIAL_KEYS = [
  'ts_iso',
  'total_cumulative',
  'last_total',
  'input',
  'output',
  'cache_creation',
  'cache_read',
  'reasoning'
];

/**
 * Canonicalize Codex fingerprint material。
 *   - ts_iso：解析後重 format 為 ISO 8601 毫秒精度 UTC
 *   - 其他 key：null/undefined → 0；數字強制 Math.trunc(Number())
 *   - 非 finite 數字 → throw
 *   - ts_iso 缺 → throw
 *
 * @param {object} raw - client 端或 server 收到的 material
 * @returns {{ts_iso, total_cumulative, last_total, input, output, cache_creation, cache_read, reasoning}}
 */
export function canonicalizeCodexMaterial(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('canonicalize: material must be an object');
  }
  const out = {};
  for (const k of CODEX_MATERIAL_KEYS) {
    const v = raw[k];
    if (v === undefined || v === null) {
      if (k === 'ts_iso') throw new Error(`canonicalize: missing required ${k}`);
      out[k] = 0;
      continue;
    }
    if (k === 'ts_iso') {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) {
        throw new Error(`canonicalize: invalid ts_iso=${v}`);
      }
      out[k] = d.toISOString();
    } else {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        throw new Error(`canonicalize: invalid ${k}=${v}`);
      }
      out[k] = Math.trunc(n);
    }
  }
  return out;
}

/**
 * 從 canonical material 算出 Codex 專用 message_id。
 * 完整 sha256（64 hex），不截斷。token_events.message_id VARCHAR(128) 可容納。
 */
export function codexMessageId(sessionId, canonicalMaterial) {
  if (!sessionId) throw new Error('codexMessageId: sessionId required');
  const m = canonicalMaterial;
  // Delimiter-collision 分析：sessionId 可含 ':'，但 canonical ts_iso 固定為
  // `YYYY-MM-DDTHH:mm:ss.sssZ`（24 chars），數字欄位不含 ':'。就算 sessionId
  // 穿插多個 ':' 也無法把 ts_iso 拆開——canonicalize 已 enforce ts_iso 長度/格式，
  // 任何 shift 攻擊都會先在 canonicalize 階段 throw。
  const payload = [
    'codex', sessionId, m.ts_iso,
    m.total_cumulative, m.last_total,
    m.input, m.output, m.cache_creation, m.cache_read, m.reasoning
  ].join(':');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * 比對兩筆 canonical material 是否相同（server fingerprint_collision audit 用）。
 * 兩筆都應該先經 canonicalizeCodexMaterial 後再比對。
 */
export function materialsEqual(a, b) {
  if (!a || !b) return false;
  for (const k of CODEX_MATERIAL_KEYS) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
