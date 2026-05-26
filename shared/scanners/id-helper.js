/**
 * shared/scanners/id-helper.js
 *
 * Codex-specific fingerprint helper. **Both client scanner and server
 * ingestion import this file**, so each side derives the same message_id
 * from the same canonical material.
 *
 * Key principles (spec S4 / D10 / D13):
 *   - Hash order: canonicalize first, then hash. Never hash raw client input
 *     directly.
 *   - Full SHA-256 (64 hex), no truncation — truncation collisions cause
 *     ON CONFLICT DO NOTHING to silently drop data.
 *   - Missing required fields → throw (upper layers decide whether to
 *     client-reject or server-400). No null→0 auto-fill.
 *
 * Claude Code / OpenCode have native ids and don't go through this helper.
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
 * Canonicalize Codex fingerprint material.
 *   - ts_iso: parsed and re-formatted to ISO-8601 millisecond UTC.
 *   - Other keys: null/undefined → 0; numbers forced via Math.trunc(Number()).
 *   - Non-finite numbers → throw.
 *   - Missing ts_iso → throw.
 *
 * @param {object} raw - material from client or server
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
 * Derive a Codex-specific message_id from canonical material.
 * Full SHA-256 (64 hex), no truncation. token_events.message_id VARCHAR(128)
 * has room.
 */
export function codexMessageId(sessionId, canonicalMaterial) {
  if (!sessionId) throw new Error('codexMessageId: sessionId required');
  const m = canonicalMaterial;
  // Delimiter-collision analysis: sessionId may contain ':', but canonical
  // ts_iso is fixed `YYYY-MM-DDTHH:mm:ss.sssZ` (24 chars) and numeric fields
  // contain no ':'. Even if sessionId is sprinkled with ':' the ts_iso can't
  // be split — canonicalize enforces ts_iso length/format, so any shift
  // attack throws during canonicalization.
  const payload = [
    'codex', sessionId, m.ts_iso,
    m.total_cumulative, m.last_total,
    m.input, m.output, m.cache_creation, m.cache_read, m.reasoning
  ].join(':');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Compare two canonical materials for equality (used in the server's
 * fingerprint_collision audit). Both inputs should be passed through
 * canonicalizeCodexMaterial first.
 */
export function materialsEqual(a, b) {
  if (!a || !b) return false;
  for (const k of CODEX_MATERIAL_KEYS) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
