/**
 * /api/bug-reports — v1.19.14 錯誤回報工具的後端 API
 *
 * 對應 OpenSpec 提案 v1.19.14-bug-report-tool（規格 §一～§六）。
 *
 * 端點：
 *   POST   /                              建立回報
 *   GET    /                              使用者列表 / 管理員看全部
 *   GET    /:id                           單筆
 *   PATCH  /:id/status                    管理員改處理狀態
 *   POST   /:id/mark-notified             使用者標通知已讀
 *   POST   /decline                       使用者拒絕（寫冷靜期）
 *   GET    /notifications                 取得通知（admin / reporter / both）
 *   POST   /notifications/mark-all-read   批量標已讀
 *   POST   /notifications/mute            靜音某 fingerprint / own_reports
 *   GET    /spam-suspects                 管理員看 spam suspect 列表
 *   POST   /spam-suspects/:id/confirm     管理員確認為 spam（觸發 24h 封鎖）
 *   POST   /spam-suspects/:id/dismiss     管理員撤銷 suspect
 *
 * 設計重點：
 *   - 認證統一走 auth middleware（每個 route 自己掛）
 *   - 管理員權限用 isAtLeast(role, 'admin') 判
 *   - confirm_string="送出" 後端守門（A2 第二道防線）
 *   - 同 fingerprint 1h 3 筆直接 429（介面層第一道防線）
 *   - 隱私強制遮蔽用 fail-closed（崩潰 → 500、不寫 DB）
 *   - spam 偵測在背景 task 跑、不卡建立流程
 */

import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import { isAtLeast } from '../middleware/adminAuth.js';
import logger from '../utils/logger.js';
import { isValidFingerprint } from '../../shared/bug-fingerprints.js';
import { validateContextBlob } from '../../shared/context-blob-schema.js';
import { redactPrivacyPatterns } from '../../shared/privacy-redact.js';
import {
  validateConfirmString,
  shouldRejectByFingerprintRateLimit,
} from '../utils/bug-report-helpers.js';
import {
  detectSpam,
  recordSpamSuspect,
} from '../services/bug-report-spam-detector.js';

const router = Router();

// ============================================================
// POST / — 建立回報
// ============================================================
router.post('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      title,
      description,
      severity,
      component,
      reproduce_input,
      context_blob,
      bug_fingerprint,
      related_lint_event_ids,
      confirm_string,
      device_fingerprint,
      client_tool,
    } = req.body || {};

    // 1. confirm_string 守門
    const confirmCheck = validateConfirmString(confirm_string);
    if (!confirmCheck.ok) {
      return res.status(400).json({ error: confirmCheck.error });
    }

    // 2. 必填欄位
    if (!title || !description) {
      return res.status(400).json({ error: 'title 與 description 必填' });
    }
    if (!bug_fingerprint || !isValidFingerprint(bug_fingerprint)) {
      return res.status(400).json({
        error: 'bug_fingerprint is required and must be a registered fingerprint. If you are reporting a newly discovered design issue and have no matching fingerprint, use "clt_user_reported_other".',
      });
    }
    if (!device_fingerprint || typeof device_fingerprint !== 'string') {
      return res.status(400).json({ error: 'device_fingerprint 必填' });
    }

    // 3. context_blob 大小與聯合型別驗證
    const blobCheck = validateContextBlob(context_blob || {});
    if (!blobCheck.ok) {
      // 1MB 超過 → 413、其他結構錯 → 400
      const status = /1MB|超過/.test(blobCheck.error) ? 413 : 400;
      return res.status(status).json({ error: blobCheck.error });
    }

    // 4. 介面層第一道防線：同 fingerprint 1h 已 3 筆 → 429
    const rateCheck = await shouldRejectByFingerprintRateLimit(
      query,
      userId,
      bug_fingerprint
    );
    if (rateCheck.reject) {
      return res.status(429).json({ error: rateCheck.message });
    }

    // 5. 隱私強制遮蔽（fail-closed：崩潰回 500、不寫 DB）
    let safeContextBlob = context_blob;
    try {
      if (context_blob && Array.isArray(context_blob.conversation_snippets)) {
        const redacted = context_blob.conversation_snippets.map((item) => {
          if (typeof item === 'string') {
            return redactPrivacyPatterns(item).text;
          }
          if (item && typeof item === 'object' && item.truncated === true) {
            return {
              ...item,
              head: redactPrivacyPatterns(item.head).text,
              tail: redactPrivacyPatterns(item.tail).text,
            };
          }
          return item;
        });
        safeContextBlob = { ...context_blob, conversation_snippets: redacted };
      }
    } catch (err) {
      logger.error('bug_report_privacy_redact_failed', {
        user_id: userId,
        error: err.message,
      });
      return res.status(500).json({
        error: '隱私遮蔽處理失敗、回報未送出、請聯絡管理員',
      });
    }

    // 6. 寫入 DB
    const insertResult = await query(
      `INSERT INTO bug_reports
        (user_id, device_fingerprint, client_tool, title, description,
         severity, component, reproduce_input, context_blob,
         context_blob_size_bytes, bug_fingerprint, related_lint_event_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, status, created_at`,
      [
        userId,
        device_fingerprint,
        client_tool || null,
        title,
        description,
        severity || 'medium',
        component || null,
        reproduce_input || null,
        safeContextBlob ? JSON.stringify(safeContextBlob) : null,
        blobCheck.size_bytes || 0,
        bug_fingerprint,
        Array.isArray(related_lint_event_ids) ? related_lint_event_ids : null,
      ]
    );
    const created = insertResult.rows[0];

    // 7. 背景跑 spam 偵測（不卡 response）
    setImmediate(() => {
      detectSpam(query, userId)
        .then(async (result) => {
          if (result.triggered) {
            await recordSpamSuspect(
              query,
              userId,
              result.trigger_rule,
              result.report_ids
            );
          }
        })
        .catch((err) => {
          logger.warn('bug_report_spam_detect_failed', {
            user_id: userId,
            error: err.message,
          });
        });
    });

    res.status(201).json(created);
  } catch (err) {
    logger.error('bug_report_create_failed', { error: err.message });
    res.status(500).json({ error: '建立回報失敗' });
  }
});

// ============================================================
// POST /decline — 使用者拒絕回報（寫冷靜期）
// ============================================================
router.post('/decline', auth, async (req, res) => {
  try {
    const { bug_fingerprint, device_fingerprint } = req.body || {};
    if (!bug_fingerprint) {
      return res.status(400).json({ error: 'bug_fingerprint 必填' });
    }
    await query(
      `INSERT INTO bug_report_declines (user_id, device_fingerprint, bug_fingerprint)
       VALUES ($1, $2, $3)`,
      [req.user.id, device_fingerprint || null, bug_fingerprint]
    );
    const cooldownUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    res.status(201).json({ cooldown_until: cooldownUntil.toISOString() });
  } catch (err) {
    logger.error('bug_report_decline_failed', { error: err.message });
    res.status(500).json({ error: '紀錄拒絕失敗' });
  }
});

// ============================================================
// GET /notifications — 取得通知列表
// ============================================================
router.get('/notifications', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const role = req.query.role || 'reporter';
    const isAdmin = isAtLeast(req.user.role, 'admin');

    if ((role === 'admin' || role === 'both') && !isAdmin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }

    const result = {};

    if (role === 'reporter' || role === 'both') {
      // 我送的、已處理但還沒讀的
      const reporterRows = await query(
        `SELECT id, title, status, status_reason, status_reason_note,
                bug_fingerprint, resolved_at
           FROM bug_reports
          WHERE user_id = $1
            AND resolved_at IS NOT NULL
            AND notified_to_reporter = false
          ORDER BY resolved_at DESC
          LIMIT 10`,
        [userId]
      );
      // 過濾掉被靜音的 fingerprint
      const mutes = await query(
        `SELECT target_value FROM bug_report_notification_mutes
          WHERE user_id = $1
            AND mute_target = 'fingerprint'
            AND muted_until > now()`,
        [userId]
      );
      const mutedFps = new Set(mutes.rows.map((r) => r.target_value));
      const recent = reporterRows.rows.filter(
        (r) => !mutedFps.has(r.bug_fingerprint)
      );
      result.reporter = {
        unread_resolved_count: recent.length,
        recent_resolved: recent,
      };
    }

    if (role === 'admin' || role === 'both') {
      // 看自己以外、未處理的回報；若管理員設了「不提醒自己」、排除自己的
      const muteOwn = await query(
        `SELECT 1 FROM bug_report_notification_mutes
          WHERE user_id = $1 AND mute_target = 'own_reports' AND muted_until > now()
          LIMIT 1`,
        [userId]
      );
      const excludeOwn = muteOwn.rows.length > 0;

      const sql = `
        SELECT id, title, severity, bug_fingerprint, user_id, created_at
          FROM bug_reports
         WHERE status = 'new'
         ${excludeOwn ? 'AND user_id <> $1' : ''}
         ORDER BY created_at DESC
         LIMIT 10
      `;
      const args = excludeOwn ? [userId] : [];
      const adminRows = await query(sql, args);

      const countSql = `
        SELECT COUNT(*)::int AS c FROM bug_reports
         WHERE status = 'new'
         ${excludeOwn ? 'AND user_id <> $1' : ''}
      `;
      const countRes = await query(countSql, args);

      result.admin = {
        unhandled_count: countRes.rows[0].c,
        recent_unhandled: adminRows.rows,
      };
    }

    res.json(result);
  } catch (err) {
    logger.error('bug_report_notifications_failed', { error: err.message });
    res.status(500).json({ error: '取得通知失敗' });
  }
});

// ============================================================
// POST /notifications/mark-all-read — 批量標已讀（reporter 用）
// ============================================================
router.post('/notifications/mark-all-read', auth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE bug_reports
          SET notified_to_reporter = true
        WHERE user_id = $1
          AND resolved_at IS NOT NULL
          AND notified_to_reporter = false`,
      [req.user.id]
    );
    res.json({ marked_count: result.rowCount });
  } catch (err) {
    logger.error('bug_report_mark_all_read_failed', { error: err.message });
    res.status(500).json({ error: '批量標已讀失敗' });
  }
});

// ============================================================
// POST /notifications/mute — 靜音某 fingerprint 或自己送的回報
// ============================================================
router.post('/notifications/mute', auth, async (req, res) => {
  try {
    const { mute_target, target_value } = req.body || {};
    if (!['fingerprint', 'own_reports'].includes(mute_target)) {
      return res.status(400).json({
        error: 'mute_target 必須是 fingerprint 或 own_reports',
      });
    }
    if (mute_target === 'fingerprint' && !target_value) {
      return res
        .status(400)
        .json({ error: 'mute_target=fingerprint 時 target_value 必填' });
    }
    if (mute_target === 'own_reports' && target_value) {
      return res
        .status(400)
        .json({ error: 'mute_target=own_reports 時 target_value 必須為空' });
    }
    await query(
      `INSERT INTO bug_report_notification_mutes (user_id, mute_target, target_value)
       VALUES ($1, $2, $3)`,
      [req.user.id, mute_target, target_value || null]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    logger.error('bug_report_mute_failed', { error: err.message });
    res.status(500).json({ error: '建立靜音紀錄失敗' });
  }
});

// ============================================================
// GET / — 列出回報（使用者看自己 / 管理員加 ?scope=all 看全部）
// ============================================================
router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const isAdmin = isAtLeast(req.user.role, 'admin');
    const scope = req.query.scope || 'mine';
    const status = req.query.status;
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const size = Math.min(Math.max(parseInt(req.query.size || '10', 10), 1), 100);
    const offset = (page - 1) * size;

    if (scope === 'all' && !isAdmin) {
      return res.status(403).json({ error: '權限不足' });
    }

    const conds = [];
    const args = [];
    if (scope !== 'all') {
      args.push(userId);
      conds.push(`user_id = $${args.length}`);
    }
    if (status) {
      args.push(status);
      conds.push(`status = $${args.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    args.push(size, offset);
    const limitOffset = `LIMIT $${args.length - 1} OFFSET $${args.length}`;

    const rows = await query(
      `SELECT id, user_id, title, severity, component, status, status_reason,
              bug_fingerprint, created_at, resolved_at
         FROM bug_reports
         ${where}
         ORDER BY created_at DESC
         ${limitOffset}`,
      args
    );
    res.json({ page, size, items: rows.rows });
  } catch (err) {
    logger.error('bug_report_list_failed', { error: err.message });
    res.status(500).json({ error: '列出回報失敗' });
  }
});

// ============================================================
// GET /spam-suspects — 管理員看 spam suspect 列表
// ============================================================
router.get('/spam-suspects', auth, async (req, res) => {
  try {
    if (!isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    const status = req.query.status || 'pending';
    const rows = await query(
      `SELECT id, user_id, triggered_at, trigger_rule, report_ids, status,
              reviewed_by, reviewed_at
         FROM bug_report_spam_suspects
        WHERE status = $1
        ORDER BY triggered_at DESC`,
      [status]
    );
    res.json({ items: rows.rows });
  } catch (err) {
    logger.error('bug_report_spam_suspects_list_failed', { error: err.message });
    res.status(500).json({ error: '取得 spam suspects 失敗' });
  }
});

// ============================================================
// POST /spam-suspects/:id/confirm — 管理員確認 spam、觸發 24h 封鎖
// ============================================================
router.post('/spam-suspects/:id/confirm', auth, async (req, res) => {
  try {
    if (!isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    const suspectId = parseInt(req.params.id, 10);
    const reason = (req.body && req.body.reason) || null;

    const result = await query(
      `UPDATE bug_report_spam_suspects
          SET status = 'confirmed_spam',
              reviewed_by = $2,
              reviewed_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING user_id`,
      [suspectId, req.user.id]
    );
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: '找不到該 suspect、或已不是 pending 狀態' });
    }

    await query(
      `INSERT INTO bug_report_spam_blocks (user_id, reason, blocked_by)
       VALUES ($1, $2, $3)`,
      [result.rows[0].user_id, reason, req.user.id]
    );

    res.json({ ok: true });
  } catch (err) {
    logger.error('bug_report_spam_confirm_failed', { error: err.message });
    res.status(500).json({ error: '確認 spam 失敗' });
  }
});

// ============================================================
// POST /spam-suspects/:id/dismiss — 管理員撤銷 suspect
// ============================================================
router.post('/spam-suspects/:id/dismiss', auth, async (req, res) => {
  try {
    if (!isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    const suspectId = parseInt(req.params.id, 10);
    const result = await query(
      `UPDATE bug_report_spam_suspects
          SET status = 'dismissed',
              reviewed_by = $2,
              reviewed_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [suspectId, req.user.id]
    );
    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: '找不到該 suspect、或已不是 pending 狀態' });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('bug_report_spam_dismiss_failed', { error: err.message });
    res.status(500).json({ error: '撤銷 suspect 失敗' });
  }
});

// ============================================================
// GET /:id — 單筆（使用者只看自己、管理員看全部）
// ============================================================
router.get('/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const isAdmin = isAtLeast(req.user.role, 'admin');
    const result = await query(`SELECT * FROM bug_reports WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該回報' });
    }
    const report = result.rows[0];
    if (!isAdmin && report.user_id !== req.user.id) {
      return res.status(403).json({ error: '權限不足' });
    }
    res.json(report);
  } catch (err) {
    logger.error('bug_report_get_failed', { error: err.message });
    res.status(500).json({ error: '取得回報失敗' });
  }
});

// ============================================================
// PATCH /:id/status — 管理員改處理狀態
// ============================================================
router.patch('/:id/status', auth, async (req, res) => {
  try {
    if (!isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    const id = parseInt(req.params.id, 10);
    const { status, status_reason, status_reason_note } = req.body || {};

    const validStatuses = ['new', 'triaged', 'in_progress', 'fixed', 'wontfix'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status 必須是 ${validStatuses.join(' / ')}` });
    }
    if (status === 'wontfix' && !status_reason) {
      return res
        .status(400)
        .json({ error: 'status=wontfix 必須帶 status_reason' });
    }
    if (status_reason === 'wontfix_other' && !status_reason_note) {
      return res
        .status(400)
        .json({ error: 'status_reason=wontfix_other 必須填補充說明' });
    }

    const isResolved = ['fixed', 'wontfix'].includes(status);
    const result = await query(
      `UPDATE bug_reports
          SET status = $2,
              status_reason = $3,
              status_reason_note = $4,
              updated_at = now(),
              resolved_at = CASE WHEN $5::bool THEN now() ELSE resolved_at END,
              resolved_by = CASE WHEN $5::bool THEN $6 ELSE resolved_by END,
              notified_to_reporter = CASE WHEN $5::bool THEN false ELSE notified_to_reporter END
        WHERE id = $1
        RETURNING id, status, resolved_at`,
      [id, status, status_reason || null, status_reason_note || null, isResolved, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該回報' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('bug_report_status_failed', { error: err.message });
    res.status(500).json({ error: '更新狀態失敗' });
  }
});

// ============================================================
// POST /:id/mark-notified — 使用者標通知已讀
// ============================================================
router.post('/:id/mark-notified', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await query(
      `UPDATE bug_reports
          SET notified_to_reporter = true
        WHERE id = $1 AND user_id = $2 AND resolved_at IS NOT NULL`,
      [id, req.user.id]
    );
    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: '找不到該回報、或尚未處理完成' });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('bug_report_mark_notified_failed', { error: err.message });
    res.status(500).json({ error: '標已讀失敗' });
  }
});

export default router;
