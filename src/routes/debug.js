import { Router } from 'express';
import logger from '../utils/logger.js';

// v1.17.85 IR-038：beacon trigger 清單（升級流程中發出、不是 self-check report）。
// 寫入 install_check_logs 時 client_version 一律 NULL，避免 sentinel 污染版號欄位。
//
// 抽成 named const + trailing underscore prefix：
//   - 未來新 kind 命名 (e.g. upgrade_failed_dirty_tree) 不會意外被當 beacon
//   - 既有 _step 級 report (upgrade_npm_install_failed / upgrade_dirty_tree) 不會誤中
const BEACON_TRIGGER_EXACT = new Set(['install_started', 'update_started']);
const BEACON_TRIGGER_PREFIXES = ['install_failed_', 'update_failed_', 'upgrade_failed_'];

function isBeaconTrigger(trigger) {
  if (!trigger || typeof trigger !== 'string') return false;
  if (BEACON_TRIGGER_EXACT.has(trigger)) return true;
  return BEACON_TRIGGER_PREFIXES.some((p) => trigger.startsWith(p));
}

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

      // v1.17.85 IR-038：beacon trigger（升級流程中發出、不是 self-check report）的
      // client_version 不可靠 — 升級剛開始時 client 端用 sentinel "install-script" /
      // "update-script" 占位，或 fail 時用 "unknown"。一律寫 NULL，避免污染
      // client_version column、誤導 admin query 把 sentinel 當 last_version。
      //
      // install_check_logs 仍會留 row（觀測管道完整）；只是 client_version 為 NULL，
      // last-version query 自然只看 self-check report (post_install / manual /
      // post_upgrade) 的真版號。
      //
      // beacon 判定邏輯抽到 isBeaconTrigger() 純函式（檔案頂端常數），
      // 未來新 kind 命名規則改變不會誤判（reviewer I1 建議）。
      const trigger = sanitizeNullBytes(body.trigger) || null;
      const clientVersion = isBeaconTrigger(trigger)
        ? null
        : (sanitizeNullBytes(body.client_version) || null);

      await query(
        `INSERT INTO install_check_logs
           (user_id, ts, client_version, platform, trigger_kind, machine, summary, full_log)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId,
          ts,
          clientVersion,
          sanitizeNullBytes(body.platform) || null,
          trigger,
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
