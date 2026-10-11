/**
 * POST /api/me/confirm-password — type the password again instead of logging in again.
 *
 * Copying a key or an install prompt needs a console login from the last 15 minutes
 * (requireRecentLogin in src/utils/web-session.js). Before this route the only way to get
 * there was logging out and back in. A correct password here stamps the session's
 * password_confirmed_at, which counts as a fresh login for that check, and nothing else:
 * the session's expiry and idle timeout stay as they were.
 *
 * Behind the login limiter in src/app.js, since it is a password check. A wrong password
 * answers 400, not 401: the console treats 401 as "logged out" and would throw the login away.
 *
 * Factory with injectable dependencies, like admin-api-key.js, so it is tested without a
 * database.
 */
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { query as defaultQuery } from '../utils/db.js';
import defaultAuth from '../middleware/auth.js';
import defaultLogger from '../utils/logger.js';

export function createConfirmPasswordRouter(deps = {}) {
  const query = deps.query || defaultQuery;
  const auth = deps.auth || defaultAuth;
  const logger = deps.logger || defaultLogger;

  const router = Router();

  router.post('/', auth, async (req, res) => {
    const password = req.body && req.body.password;
    if (typeof password !== 'string' || password === '') {
      return res.status(400).json({ error: '請輸入密碼' });
    }
    if (req.sessionId == null) {
      // An api_key caller is never asked for a fresh login, so there is nothing to confirm.
      return res.status(400).json({ error: '這個動作只能在後台網頁上操作' });
    }
    try {
      const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
      const hash = result.rows[0] && result.rows[0].password_hash;
      if (!hash || !(await bcrypt.compare(password, hash))) {
        return res.status(400).json({ error: '密碼不正確，請再輸入一次' });
      }
      await query(
        'UPDATE web_sessions SET password_confirmed_at = NOW() WHERE id = $1',
        [req.sessionId]
      );
      res.json({ ok: true });
    } catch (err) {
      logger.error('me/confirm-password failed', { error: err.message });
      res.status(500).json({ error: '確認密碼失敗，請稍後再試' });
    }
  });

  return router;
}

export default createConfirmPasswordRouter();
