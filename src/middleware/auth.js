import { query } from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * API Key 認證中介層
 * 從 Authorization header 取得 Bearer token，查詢 users 表驗證
 */
export default async function auth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '未提供認證令牌' });
    }

    const apiKey = authHeader.slice(7);

    const result = await query(
      'SELECT id, email, name, role, settings, created_at FROM users WHERE api_key = $1',
      [apiKey]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: '無效的 API Key' });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    logger.error('認證失敗', { error: err.message });
    res.status(500).json({ error: '認證過程發生錯誤' });
  }
}
