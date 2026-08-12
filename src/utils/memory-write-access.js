/**
 * Who may change a memory row.
 *
 * Every write route used to open with `SELECT * FROM memories WHERE id = $1 AND user_id = $2`,
 * which answers "not yours" and "does not exist" with the same 404. For private types that is
 * exactly right. For the two shared types it meant a team standard could only ever be changed
 * by the account that uploaded it: the admin-only check further down each handler could not be
 * reached by a non-owner, because the lookup had already 404'd. Standards spread across several
 * accounts therefore had no one who could edit them all, and a standard outlived its creator's
 * account as a row nobody could edit, retire, or restore.
 *
 * This module owns the single answer to "may this caller write to this row", so the edit,
 * disable, enable and revert paths cannot drift apart.
 *
 * Reading is a different question and stays in `memory-visibility.js`: every member reads
 * team standards, and none of that implies being able to change one.
 */

import { isSharedMemoryType } from './memory-visibility.js';
import { isAtLeast } from './roles.js';

/**
 * A refusal. Missing rows and rows the caller may not touch answer identically — anything
 * else tells the caller which ids exist on other accounts.
 */
const REFUSED = Object.freeze({ ok: false, status: 404, error: 'Memory not found' });

/**
 * Resolve the row a write route is about to act on, and say on what authority.
 *
 * @param {object} options
 * @param {string|number} options.id row id from the request path
 * @param {{ id?: string|number, role?: string }} options.user the authenticated caller
 * @param {(sql: string, params: unknown[]) => Promise<{ rows: object[] }>} options.queryFn
 * @returns {Promise<{ ok: true, memory: object, viaAdmin: boolean }
 *                  | { ok: false, status: number, error: string }>}
 */
export async function resolveWritableMemory({ id, user, queryFn }) {
  const found = await queryFn('SELECT * FROM memories WHERE id = $1', [id]);
  if (found.rows.length === 0) return REFUSED;

  const memory = found.rows[0];

  // Ids come back as strings through some drivers and as numbers through others; comparing
  // them as they arrive would make an owner a stranger to their own row.
  if (user && String(memory.user_id) === String(user.id)) {
    return { ok: true, memory, viaAdmin: false };
  }

  if (isSharedMemoryType(memory.type) && isAtLeast(user?.role, 'admin')) {
    return { ok: true, memory, viaAdmin: true };
  }

  return REFUSED;
}
