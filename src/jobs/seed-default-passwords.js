/**
 * v1.17.25: Server boot 時補預設密碼給沒有 password_hash 的 user
 * v1.19.10: 固定預設密碼 'Password42760988' 被移除（repo 公開後外洩）。
 *           改成「每個 user 各別產隨機密碼」、寫入 server log 一次（含 user email 跟臨時密碼）、
 *           不存任何固定字串。admin 看 server log 才能拿到、轉告對方後該行紀錄即作廢。
 *
 * 已有 password_hash 的 user（之前 admin 自己設過密碼）不動。
 *
 * 跑一次性、idempotent：只 UPDATE password_hash IS NULL 的 row。
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
      return; // 沒人需要補
    }

    // v1.19.10：每個 user 各別產隨機密碼、逐一 UPDATE
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

    // 寫進 server log（一次性、不存其他地方）給 admin 查
    // ⚠️ log 是 sensitive 資訊、部署環境的 log 收集器要留意（建議只在 stdout、不另送雲端）
    logger.warn(
      `已補隨機臨時密碼給 ${generated.length} 位 user（必須改密碼）。請從本機 server log 取得、轉告對方後該行 log 即作廢：`,
      { entries: generated }
    );
  } catch (err) {
    logger.error('seedDefaultPasswords 失敗', { error: err.message });
  }
}
