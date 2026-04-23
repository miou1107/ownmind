import { Router } from 'express';
import { query as defaultQuery } from '../utils/db.js';
import defaultAuth from '../middleware/auth.js';
import defaultAdminAuth, { superAdminAuth as defaultSuperAdminAuth } from '../middleware/adminAuth.js';
import logger from '../utils/logger.js';
import { filterVisibleBroadcasts, filterInjectable } from '../lib/broadcast-filter.js';

const VALID_TYPES = new Set(['announcement', 'upgrade_reminder', 'maintenance', 'rule_change']);
const VALID_SEVERITY = new Set(['info', 'warning', 'critical']);

/**
 * coerceNum — 把 JSON 送來的 number / numeric string（"24"）統一 coerce 成 number；
 * 不合法或 NaN 都 fallback 到 default。避免 Number.isFinite("24") === false 的坑。
 */
function coerceNum(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Broadcast system — admin 發的通用廣播 + user 端查詢 / snooze / dismiss
 *
 * Admin：
 *   POST   /api/broadcast/admin            super_admin   新增
 *   GET    /api/broadcast/admin            admin+        列出（含歷史）
 *   PATCH  /api/broadcast/admin/:id        super_admin   更新 ends_at / target_users
 *   DELETE /api/broadcast/admin/:id        super_admin   撤銷（soft delete = ends_at=NOW()）
 *
 * User：
 *   GET    /api/broadcast/active?tool=X    all（auth 過的 user）   取當下應顯示的廣播
 *   POST   /api/broadcast/dismiss          all                     { broadcast_id, tool, snooze_hours? }
 */
export function createBroadcastRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const auth = deps.auth ?? defaultAuth;
  const adminAuth = deps.adminAuth ?? defaultAdminAuth;
  const superAdminAuth = deps.superAdminAuth ?? defaultSuperAdminAuth;
  const now = deps.now ?? (() => new Date());

  const router = Router();

  // ============================================================
  // Admin: 新增廣播
  // ============================================================
  router.post('/admin', superAdminAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const err = validateBroadcastPayload(body);
      if (err) return res.status(400).json({ error: err });

      const result = await query(
        `INSERT INTO broadcast_messages
         (type, severity, title, body,
          cta_text, cta_action,
          min_version, max_version, target_users,
          allow_snooze, snooze_hours, cooldown_minutes,
          starts_at, ends_at, created_by, is_auto)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, FALSE)
         RETURNING id, type, severity, title, body, starts_at, ends_at, is_auto, created_at`,
        [
          body.type,
          body.severity || 'info',
          body.title,
          body.body,
          body.cta_text || null,
          body.cta_action || null,
          body.min_version || null,
          body.max_version || null,
          Array.isArray(body.target_users) && body.target_users.length > 0 ? body.target_users : null,
          Boolean(body.allow_snooze),
          coerceNum(body.snooze_hours, 24),
          coerceNum(body.cooldown_minutes, 1440),
          body.starts_at ? new Date(body.starts_at) : new Date(),
          body.ends_at ? new Date(body.ends_at) : null,
          req.user.id
        ]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      logger.error('broadcast 新增失敗', { error: err.message });
      res.status(500).json({ error: '新增廣播失敗：' + err.message });
    }
  });

  // ============================================================
  // Admin: 列出廣播（預設 active=true，全部歷史用 ?include_ended=true）
  // ============================================================
  router.get('/admin', adminAuth, async (req, res) => {
    try {
      const includeEnded = req.query.include_ended === 'true';
      const sql = includeEnded
        ? `SELECT * FROM broadcast_messages ORDER BY created_at DESC LIMIT 200`
        : `SELECT * FROM broadcast_messages
           WHERE ends_at IS NULL OR ends_at > NOW()
           ORDER BY created_at DESC LIMIT 200`;
      const result = await query(sql);
      res.json(result.rows);
    } catch (err) {
      logger.error('broadcast 列表失敗', { error: err.message });
      res.status(500).json({ error: '查詢廣播失敗' });
    }
  });

  // ============================================================
  // Admin: 更新 / 撤銷
  // ============================================================
  router.patch('/admin/:id', superAdminAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const body = req.body || {};
      const fields = [];
      const params = [];
      if (body.ends_at !== undefined) {
        // 允許 null 清除；其他值必須可 parse
        let endsAt = null;
        if (body.ends_at !== null) {
          endsAt = new Date(body.ends_at);
          if (!Number.isFinite(endsAt.getTime())) {
            return res.status(400).json({ error: 'ends_at 格式不正確' });
          }
        }
        params.push(endsAt); fields.push(`ends_at = $${params.length}`);
      }
      if (body.target_users !== undefined) {
        let val = null;
        if (Array.isArray(body.target_users) && body.target_users.length > 0) {
          for (const uid of body.target_users) {
            if (!Number.isInteger(uid) || uid <= 0) {
              return res.status(400).json({ error: 'target_users 必須是正整數陣列' });
            }
          }
          val = body.target_users;
        }
        params.push(val); fields.push(`target_users = $${params.length}`);
      }
      if (fields.length === 0) return res.status(400).json({ error: 'no updatable fields' });
      params.push(id);
      const result = await query(
        `UPDATE broadcast_messages SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING id, ends_at, target_users`,
        params
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'not found' });
      res.json(result.rows[0]);
    } catch (err) {
      logger.error('broadcast 更新失敗', { error: err.message });
      res.status(500).json({ error: '更新廣播失敗：' + err.message });
    }
  });

  router.delete('/admin/:id', superAdminAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

      // 先查 is_auto — auto-managed 廣播由 nightly job 掌控，不允許手動撤銷
      // （若撤了，job 因 active-only check 會在下一輪重建，形成無意義循環）
      const check = await query(`SELECT is_auto FROM broadcast_messages WHERE id = $1`, [id]);
      if (check.rowCount === 0) return res.status(404).json({ error: 'not found' });
      if (check.rows[0].is_auto) {
        return res.status(400).json({
          error: 'auto-managed 廣播不可手動撤銷（由 nightly job 管理）'
        });
      }

      const result = await query(
        `UPDATE broadcast_messages SET ends_at = NOW()
         WHERE id = $1 AND (ends_at IS NULL OR ends_at > NOW()) RETURNING id`,
        [id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'already ended' });
      res.json({ id, revoked: true });
    } catch (err) {
      logger.error('broadcast 撤銷失敗', { error: err.message });
      res.status(500).json({ error: '撤銷廣播失敗：' + err.message });
    }
  });

  // ============================================================
  // User: 取當前應看到的廣播
  // ============================================================
  router.get('/active', auth, async (req, res) => {
    try {
      const tool = String(req.query.tool || '').trim();
      if (!tool) return res.status(400).json({ error: 'tool 是必填' });
      const client_version = req.query.client_version
        || req.headers['x-ownmind-version']
        || null;

      const rows = await filterVisibleBroadcasts(query, {
        user_id: req.user.id,
        tool,
        client_version,
        now: now()
      });
      res.json(rows);
    } catch (err) {
      logger.error('broadcast/active 查詢失敗', { error: err.message });
      res.status(500).json({ error: '查詢廣播失敗' });
    }
  });

  // ============================================================
  // User: dismiss / snooze
  // ============================================================
  router.post('/dismiss', auth, async (req, res) => {
    try {
      const body = req.body || {};
      const broadcast_id = parseInt(body.broadcast_id, 10);
      const tool = String(body.tool || '').trim();
      if (!Number.isFinite(broadcast_id) || !tool) {
        return res.status(400).json({ error: 'broadcast_id 與 tool 都必填' });
      }

      // 可見性檢查（Critical 修補）：必須確認該 user 當前能看到這則廣播才允許 dismiss
      // 否則 user 可 pre-dismiss 未來的針對性廣播，繞過 admin 的 targeting 保證
      const client_version = req.query.client_version
        || req.headers['x-ownmind-version']
        || null;
      const visible = await filterVisibleBroadcasts(query, {
        user_id: req.user.id,
        tool,
        client_version,
        now: now()
      });
      const bc = visible.find((b) => b.id === broadcast_id);
      if (!bc) {
        return res.status(404).json({ error: 'broadcast 不存在或不在你的可見範圍' });
      }

      const hasSnoozeArg = body.snooze_hours !== undefined && body.snooze_hours !== null;
      const parsedSnoozeHours = hasSnoozeArg ? Number(body.snooze_hours) : undefined;
      const isSnooze = hasSnoozeArg && Number.isFinite(parsedSnoozeHours) && parsedSnoozeHours > 0;
      if (hasSnoozeArg && !isSnooze) {
        return res.status(400).json({ error: 'snooze_hours 必須為正數' });
      }
      if (isSnooze && !bc.allow_snooze) {
        return res.status(400).json({ error: '此廣播不允許 snooze（請用 dismiss）' });
      }

      const nowTs = now();
      let snoozeUntil = null;
      let dismissedAt = null;
      if (isSnooze) {
        snoozeUntil = new Date(nowTs.getTime() + parsedSnoozeHours * 3_600_000);
      } else {
        dismissedAt = nowTs;
      }

      await query(
        `INSERT INTO user_broadcast_state (user_id, broadcast_id, tool, dismissed_at, snooze_until)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, broadcast_id, tool) DO UPDATE
           SET dismissed_at = EXCLUDED.dismissed_at,
               snooze_until = EXCLUDED.snooze_until`,
        [req.user.id, broadcast_id, tool, dismissedAt, snoozeUntil]
      );
      res.json({
        broadcast_id, tool,
        dismissed: !isSnooze,
        snooze_until: snoozeUntil
      });
    } catch (err) {
      logger.error('broadcast/dismiss 失敗', { error: err.message });
      res.status(500).json({ error: 'dismiss 失敗：' + err.message });
    }
  });

  // ============================================================
  // MCP: 取「現在該注入的廣播」— 每次 ownmind_* tool call 時都 ping
  //
  // 此 endpoint 負責「時機決策」而非「可見性」：
  //   1. Upsert user_tool_last_seen（供首次 / 4h 判定）
  //   2. 判 is_first_of_day（Asia/Taipei）、is_long_gap（> 4h）
  //   3. filterVisibleBroadcasts → filterInjectable（forceInject=首次 or 長間隔）
  //   4. Mark last_injected_at 於 user_broadcast_state
  //   5. 回傳 { broadcasts: [...] } 給 MCP client prepend 到 tool response text
  //
  // Server side effects only，MCP client 只要把回來的文字塞前面即可。
  // ============================================================
  router.post('/inject', auth, async (req, res) => {
    try {
      const tool = String((req.body && req.body.tool) || req.query.tool || '').trim();
      if (!tool) return res.status(400).json({ error: 'tool 是必填' });
      const client_version = (req.body && req.body.client_version)
        || req.query.client_version
        || req.headers['x-ownmind-version']
        || null;

      const nowTs = now();
      const user_id = req.user.id;

      // 1. 取上次 seen（判首次 / 4h）
      const seen = await query(
        `SELECT last_mcp_call_at, last_day_seen_tpe FROM user_tool_last_seen
          WHERE user_id = $1 AND tool = $2`,
        [user_id, tool]
      );
      const prev = seen.rows[0] || null;
      const todayTpe = toTpeDate(nowTs);
      const isFirstOfDay = !prev
        || !prev.last_day_seen_tpe
        || new Date(prev.last_day_seen_tpe).toISOString().slice(0, 10) < todayTpe;
      const isLongGap = !!prev && prev.last_mcp_call_at
        && (nowTs.getTime() - new Date(prev.last_mcp_call_at).getTime()) > 4 * 3600 * 1000;
      const forceInject = isFirstOfDay || isLongGap;

      // 2. Upsert user_tool_last_seen（即使沒廣播要 inject，也要更新）
      await query(
        `INSERT INTO user_tool_last_seen (user_id, tool, last_mcp_call_at, last_day_seen_tpe)
         VALUES ($1, $2, $3, $4::date)
         ON CONFLICT (user_id, tool) DO UPDATE
           SET last_mcp_call_at = EXCLUDED.last_mcp_call_at,
               last_day_seen_tpe = EXCLUDED.last_day_seen_tpe`,
        [user_id, tool, nowTs, todayTpe]
      );

      // 3. filter visible → injectable
      const visible = await filterVisibleBroadcasts(query, {
        user_id, tool, client_version, now: nowTs
      });
      const injectable = filterInjectable(visible, { forceInject, now: nowTs });

      if (injectable.length === 0) {
        return res.json({ broadcasts: [], force: forceInject });
      }

      // 4. Mark last_injected_at for each（non-blocking 方式，但用 Promise.all 保證 response 前完成）
      const ids = injectable.map((bc) => bc.id);
      await query(
        `INSERT INTO user_broadcast_state (user_id, broadcast_id, tool, last_injected_at)
         SELECT $1, id, $2, $3 FROM unnest($4::int[]) AS id
         ON CONFLICT (user_id, broadcast_id, tool) DO UPDATE
           SET last_injected_at = EXCLUDED.last_injected_at`,
        [user_id, tool, nowTs, ids]
      );

      // 5. 回傳 — 只帶 MCP client 需要的欄位，不洩 internal state
      res.json({
        broadcasts: injectable.map((bc) => ({
          id: bc.id,
          type: bc.type,
          severity: bc.severity,
          title: bc.title,
          body: bc.body,
          cta_text: bc.cta_text,
          cta_action: bc.cta_action,
          allow_snooze: bc.allow_snooze,
          snooze_hours: bc.snooze_hours
        })),
        force: forceInject
      });
    } catch (err) {
      logger.error('broadcast/inject 失敗', { error: err.message });
      res.status(500).json({ error: 'inject 失敗：' + err.message });
    }
  });

  return router;
}

function toTpeDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

/**
 * 驗證 POST /admin 的 payload。
 * 注意：對 string-number（`"24"`）先用 Number() coerce，避免 JSON 整數字串被誤拒。
 * 同時驗證 starts_at / ends_at 可 parse + 邏輯關係（ends_at > starts_at）。
 */
export function validateBroadcastPayload(body) {
  if (!body || typeof body !== 'object') return 'body 必須是 object';
  if (!VALID_TYPES.has(body.type)) return `type 必須為 ${[...VALID_TYPES].join(' / ')}`;
  if (body.severity && !VALID_SEVERITY.has(body.severity)) {
    return `severity 必須為 ${[...VALID_SEVERITY].join(' / ')}`;
  }
  if (typeof body.title !== 'string' || body.title.trim().length === 0) return 'title 必填';
  if (body.title.length > 200) return 'title 不可超過 200 字';
  if (typeof body.body !== 'string' || body.body.trim().length === 0) return 'body 必填';
  if (body.body.length > 2000) return 'body 不可超過 2000 字';
  if (body.target_users !== undefined && body.target_users !== null) {
    if (!Array.isArray(body.target_users)) return 'target_users 必須是 array';
    for (const uid of body.target_users) {
      if (!Number.isInteger(uid) || uid <= 0) return 'target_users 必須是正整數陣列';
    }
  }
  if (body.snooze_hours !== undefined && body.snooze_hours !== null) {
    const n = Number(body.snooze_hours);
    if (!Number.isFinite(n) || n <= 0) return 'snooze_hours 必須為正數';
  }
  if (body.cooldown_minutes !== undefined && body.cooldown_minutes !== null) {
    const n = Number(body.cooldown_minutes);
    if (!Number.isFinite(n) || n < 0) return 'cooldown_minutes 必須為 0 或正數';
  }

  // Date 驗證：parseable + ends_at > starts_at
  const parseDate = (v) => {
    if (v === undefined || v === null || v === '') return { ok: true, date: null };
    if (v instanceof Date) {
      return Number.isFinite(v.getTime()) ? { ok: true, date: v } : { ok: false };
    }
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? { ok: true, date: d } : { ok: false };
  };
  const sp = parseDate(body.starts_at);
  if (!sp.ok) return 'starts_at 格式不正確（需為 ISO 8601 或 Date）';
  const ep = parseDate(body.ends_at);
  if (!ep.ok) return 'ends_at 格式不正確（需為 ISO 8601 或 Date）';
  if (sp.date && ep.date && ep.date.getTime() <= sp.date.getTime()) {
    return 'ends_at 必須晚於 starts_at';
  }

  return null;
}

export default createBroadcastRouter();
