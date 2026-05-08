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
      // v1.17.78（IR-038）：接受 install_started / install_failed_* 這類 beacon
      // payload — 比 self-check 報告更早送出，讓 admin 至少看到「user 嘗試裝過」。
      // 必填欄位只剩 ts；checks / summary 可缺省為空。
      if (!body.ts) {
        return res.status(400).json({ error: 'missing ts' });
      }
      const ts = new Date(body.ts);
      if (Number.isNaN(ts.getTime())) {
        return res.status(400).json({ error: 'invalid ts' });
      }
      // checks 是選填的；給的話必須是 array 且 status 合法
      if (body.checks !== undefined) {
        if (!Array.isArray(body.checks)) {
          return res.status(400).json({ error: 'checks must be array' });
        }
        const validStatus = new Set(['pass', 'warn', 'fail']);
        if (!body.checks.every((c) => c && validStatus.has(c.status))) {
          return res.status(400).json({ error: 'invalid check status' });
        }
      }
      // summary 也是選填；給的話必須是 object
      if (body.summary !== undefined && (typeof body.summary !== 'object' || Array.isArray(body.summary))) {
        return res.status(400).json({ error: 'summary must be object' });
      }
      const checks = body.checks || [];
      const summary = body.summary || { pass: 0, warn: 0, fail: 0 };
      // 砍超大 payload 防濫用（正常 ~2KB，給 64KB 上限）
      const fullLog = JSON.stringify(body);
      if (fullLog.length > 64 * 1024) {
        return res.status(413).json({ error: 'payload too large' });
      }

      // v1.17.83 — Postgres JSONB 嚴格拒絕 ；client 端 mojibake / 髒環境變數會引入。
      // 寫入前先 strip null byte，其他控制字元 JSON 規格允許不需動。
      // 真實案例：vin-windows-test 第六輪 server log 連續 5xx「unsupported Unicode escape sequence」
      // 都是同一筆 payload 含 null byte 反覆重送（搭配 client 端 retrySpool cap 兩端對稱守住）。
      const sanitizeNullBytes = (s) => (typeof s === 'string' ? s.replace(/\u0000/g, '').replace(/\\u0000/g, '') : s);

      await query(
        `INSERT INTO install_check_logs
           (user_id, ts, client_version, platform, trigger_kind, machine, summary, full_log)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId,
          ts,
          sanitizeNullBytes(body.client_version) || null,
          sanitizeNullBytes(body.platform) || null,
          sanitizeNullBytes(body.trigger) || null,
          sanitizeNullBytes(body.machine) || null,
          sanitizeNullBytes(JSON.stringify(summary)),
          sanitizeNullBytes(fullLog),
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
