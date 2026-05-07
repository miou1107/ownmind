/**
 * v1.17.25: Server boot 時補預設密碼給沒有 password_hash 的 user
 *
 * 預設密碼：Password42760988（must_change_password = TRUE，登入後強制改）
 * 已有 password_hash 的 user（之前 admin 自己設過密碼）不動。
 *
 * 跑一次性、idempotent：只 UPDATE password_hash IS NULL 的 row。
 */

import bcrypt from 'bcrypt';
import { query } from '../utils/db.js';
import logger from '../utils/logger.js';

const DEFAULT_PASSWORD = 'Password42760988';
const BCRYPT_ROUNDS = 10;

export async function seedDefaultPasswords() {
  try {
    const noPwd = await query(
      `SELECT id, email, name FROM users WHERE password_hash IS NULL`
    );
    if (noPwd.rows.length === 0) {
      return; // 沒人需要補
    }

    const hash = await bcrypt.hash(DEFAULT_PASSWORD, BCRYPT_ROUNDS);
    await query(
      `UPDATE users
       SET password_hash = $1,
           must_change_password = TRUE
       WHERE password_hash IS NULL`,
      [hash]
    );

    logger.info(`已補預設密碼給 ${noPwd.rows.length} 位 user（必須改密碼）`, {
      users: noPwd.rows.map(r => r.email),
    });
  } catch (err) {
    logger.error('seedDefaultPasswords 失敗', { error: err.message });
  }
}
