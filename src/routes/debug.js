import { Router } from 'express';
import logger from '../utils/logger.js';

/**
 * Debug routes — 收 client 端 self-check 上傳。
 *
 * POST /api/debug/install-check
 *   Body: { ts, trigger, client_version, platform, node_version, machine, checks, summary }
 *   Auth: 一般 user API key
 *   存到 install_check_logs，給 admin dashboard 查每個 user 的安裝健康度。
 */
export function createDebugRouter({ query, auth }) {
  const router = Router();

  router.post('/install-check', auth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'unauthenticated' });

      const body = req.body || {};
      // 基本欄位驗證 — 失敗就丟棄、回 400 而不是 500
      if (!body.ts || !Array.isArray(body.checks) || !body.summary) {
        return res.status(400).json({ error: 'missing required fields' });
      }
      const ts = new Date(body.ts);
      if (Number.isNaN(ts.getTime())) {
        return res.status(400).json({ error: 'invalid ts' });
      }
      // checks[*].status 限 pass / warn / fail 三選一，防 client 亂送髒資料
      const validStatus = new Set(['pass', 'warn', 'fail']);
      if (!body.checks.every((c) => c && validStatus.has(c.status))) {
        return res.status(400).json({ error: 'invalid check status' });
      }
      // 砍超大 payload 防濫用（正常 ~2KB，給 64KB 上限）
      const fullLog = JSON.stringify(body);
      if (fullLog.length > 64 * 1024) {
        return res.status(413).json({ error: 'payload too large' });
      }

      await query(
        `INSERT INTO install_check_logs
           (user_id, ts, client_version, platform, trigger_kind, machine, summary, full_log)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId,
          ts,
          body.client_version || null,
          body.platform || null,
          body.trigger || null,
          body.machine || null,
          JSON.stringify(body.summary),
          fullLog,
        ]
      );

      res.json({ ok: true });
    } catch (err) {
      logger.error?.('install-check 寫入失敗', { error: err?.message });
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}

export default createDebugRouter;
