/**
 * v1.17.25: at server boot, seed a default password for users without a password_hash
 * v1.19.10: the fixed default password was removed (it leaked once the repo went public).
 *           Changed to "generate a random password per user", written to the server log
 *           once (including user email and the temporary password), with no fixed string
 *           stored anywhere. The admin can only obtain it from the server log; once relayed
 *           to the person, that log line is void.
 *
 * Users that already have a password_hash (the admin set one previously) are untouched.
 *
 * One-shot, idempotent: only UPDATEs rows where password_hash IS NULL.
 */

import bcrypt from 'bcrypt';
import { query } from '../utils/db.js';
import logger from '../utils/logger.js';
import { generateRandomPassword } from '../../shared/random-password.js';

const BCRYPT_ROUNDS = 10;

export async function seedDefaultPasswords() {
  try {
    const noPwd = await query(
      `SELECT id, email, name FROM users WHERE password_hash IS NULL`
    );
    if (noPwd.rows.length === 0) {
      return; // nobody needs seeding
    }

    // v1.19.10: generate a random password per user, UPDATE one by one
    const generated = [];
    for (const u of noPwd.rows) {
      const password = generateRandomPassword();
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await query(
        `UPDATE users
           SET password_hash = $1,
               must_change_password = TRUE
         WHERE id = $2 AND password_hash IS NULL`,
        [hash, u.id]
      );
      generated.push({ email: u.email, password });
    }

    // write to the server log (one-shot, not stored anywhere else) for the admin to read
    // ⚠️ this log contains sensitive info; be careful with the deploy environment's log
    // collector (recommend stdout only, do not forward to the cloud)
    logger.warn(
      `Seeded a random temporary password for ${generated.length} user(s) (must change password). Obtain it from the local server log; once relayed to the person, this log line is void:`,
      { entries: generated }
    );
  } catch (err) {
    logger.error('seedDefaultPasswords failed', { error: err.message });
  }
}
