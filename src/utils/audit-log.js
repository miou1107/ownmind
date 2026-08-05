// Writes an `audit_logs` row, and never lets that failure take the caller down.
//
// Lived inside src/routes/admin.js until v1.26.60, which needed it in two routers rather
// than one: `POST /api/admin/login` was deleted with the legacy console, and it held the
// only write of the `login` action. Measured on production 2026-08-05 — **zero login rows
// in sixty days** — because everyone had already moved to `POST /api/me/login`, which
// never wrote one. So login auditing did not end with the deletion; it ended silently two
// months earlier, and moving the write here reconnects it to the endpoint people use.
//
// Failures are logged and swallowed on purpose: an audit row is a record of something
// that already happened, so refusing the request because the record failed would turn a
// successful login into an error.

import { query } from './db.js';
import logger from './logger.js';

/**
 * @param {number} actorId    Who did it.
 * @param {string} action     e.g. 'login', 'create_user', 'change_password'.
 * @param {string} targetType e.g. 'user'.
 * @param {number} targetId   What it was done to.
 * @param {object} details    Anything else worth keeping; serialised to JSON.
 */
export async function writeAuditLog(actorId, action, targetType, targetId, details) {
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorId, action, targetType, targetId, JSON.stringify(details)]
    );
  } catch (err) {
    logger.error('audit_log write failed', { error: err.message, action });
  }
}
