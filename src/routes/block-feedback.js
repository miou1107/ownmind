/**
 * block-feedback.js — POST /api/feedback/block route
 *
 * Optional auth：有 Bearer header 就驗（CLI path）、沒有就走 sig path（Web path）。
 * 核心邏輯在 src/lib/block-feedback.js，這支只是 thin wrapper。
 */

import { Router } from 'express';
import { query as defaultQuery } from '../utils/db.js';
import logger from '../utils/logger.js';
import { handleBlockFeedback } from '../lib/block-feedback.js';
import { deriveSecret } from '../utils/feedback-sig.js';

export function createBlockFeedbackRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const now = deps.now ?? (() => Date.now());
  // module load 時 derive；ENCRYPTION_KEY 是 fail-fast、所以這裡保證可用
  const secret = deps.secret ?? deriveSecret(process.env.ENCRYPTION_KEY);

  const router = Router();

  router.post('/', async (req, res) => {
    // Optional auth：有 Bearer 就嘗試驗、沒有就走 sig path
    let user = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const apiKey = authHeader.slice(7);
      try {
        const r = await query(
          'SELECT id, role FROM users WHERE api_key = $1',
          [apiKey]
        );
        if (r.rows.length === 0) {
          return res.status(401).json({ error: '無效的 API Key' });
        }
        user = r.rows[0];
      } catch (err) {
        logger.error('block-feedback auth 失敗', { error: err.message });
        return res.status(500).json({ error: 'auth error' });
      }
    }

    try {
      const result = await handleBlockFeedback({
        body: req.body || {},
        query,
        secret,
        now: now(),
        user,
      });
      return res.status(result.status).json(result.body);
    } catch (err) {
      logger.error('block-feedback 寫入失敗', { error: err.message });
      return res.status(500).json({ error: 'internal error' });
    }
  });

  return router;
}

export default createBlockFeedbackRouter();
