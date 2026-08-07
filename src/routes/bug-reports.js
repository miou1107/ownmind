/**
 * /api/bug-reports — backend API for the v1.19.14 bug-report tool.
 *
 * Corresponds to OpenSpec proposal v1.19.14-bug-report-tool (§I–§VI).
 *
 * Endpoints:
 *   POST   /                              create a report
 *   GET    /                              user list / admin sees all
 *   GET    /:id                           single row
 *   PATCH  /:id/status                    admin updates processing status
 *   POST   /:id/mark-notified             user marks notification as read
 *   POST   /decline                       user declines (writes a cool-down)
 *   GET    /notifications                 fetch notifications (admin / reporter / both)
 *   POST   /notifications/mark-all-read   batch mark read
 *   POST   /notifications/mute            mute by fingerprint / own_reports
 *   GET    /spam-suspects                 admin sees the spam suspect list
 *   POST   /spam-suspects/:id/confirm     admin confirms as spam (triggers 24h block)
 *   POST   /spam-suspects/:id/dismiss     admin dismisses a suspect
 *
 * Design points:
 *   - Auth is unified via the auth middleware (mounted per route).
 *   - Admin permission uses isAtLeast(role, 'admin').
 *   - confirm_string is checked for value, which is NOT the same as verifying that a human
 *     typed it. The server sees a string equal to the expected phrase and cannot tell who
 *     produced those characters; the AI holds the same API key as the person, so no
 *     server-side check can separate them. `confirmation_declared` records what the client
 *     said about it — a declaration, never a verification. See db/022.
 *   - Three same-fingerprint reports within 1 hour → 429 (UI is the first
 *     line of defense).
 *   - Privacy redaction is fail-closed (crash → 500, no DB write).
 *   - Spam detection runs in a background task; doesn't block the create flow.
 */

import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import { isAtLeast } from '../middleware/adminAuth.js';
import { normalizeConfirmationDeclared } from '../utils/confirmation-declared.js';
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

// Allowed status_reason values, kept in lockstep with the
// bug_reports_status_reason_check DB constraint (db/017_bug_reports_id_to_serial.sql).
const ALLOWED_STATUS_REASONS = [
  'by_design',
  'duplicate',
  'low_priority',
  'cannot_reproduce',
  'wontfix_other',
];

// ============================================================
// POST / — create a report.
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
      confirmation_declared,
      device_fingerprint,
      client_tool,
    } = req.body || {};

    // 1. Confirm-string check.
    //
    // This checks the value, not its provenance. It stops a call that never went through
    // the confirmation step at all; it does not — and cannot — stop the AI from typing the
    // phrase itself. Whatever the client says about that is recorded below as a claim.
    const confirmCheck = validateConfirmString(confirm_string);
    if (!confirmCheck.ok) {
      return res.status(400).json({ error: confirmCheck.error });
    }

    const declared = normalizeConfirmationDeclared(confirmation_declared);

    // 2. Required fields.
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description are required' });
    }
    if (!bug_fingerprint || !isValidFingerprint(bug_fingerprint)) {
      return res.status(400).json({
        error: 'bug_fingerprint is required and must be a registered fingerprint. If you are reporting a newly discovered design issue and have no matching fingerprint, use "clt_user_reported_other".',
      });
    }
    if (!device_fingerprint || typeof device_fingerprint !== 'string') {
      return res.status(400).json({ error: 'device_fingerprint is required' });
    }

    // 3. context_blob size and union-type validation.
    const blobCheck = validateContextBlob(context_blob || {});
    if (!blobCheck.ok) {
      // Over 1MB → 413; other shape errors → 400.
      // Accept both Chinese 超過 and English exceeds to remain compatible
      // with prior validateContextBlob output.
      const status = /1MB|超過|exceeds/.test(blobCheck.error) ? 413 : 400;
      return res.status(status).json({ error: blobCheck.error });
    }

    // 4. UI rate limit: same fingerprint, 3 reports in 1 hour → 429.
    const rateCheck = await shouldRejectByFingerprintRateLimit(
      query,
      userId,
      bug_fingerprint
    );
    if (rateCheck.reject) {
      return res.status(429).json({ error: rateCheck.message });
    }

    // 5. Mandatory privacy redaction (fail-closed: crash → 500, no DB write).
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
        error: 'Privacy redaction failed; the report was not sent. Please contact the administrator.',
      });
    }

    // 6. Write to the DB.
    const insertResult = await query(
      `INSERT INTO bug_reports
        (user_id, device_fingerprint, client_tool, title, description,
         severity, component, reproduce_input, context_blob,
         context_blob_size_bytes, bug_fingerprint, related_lint_event_ids,
         confirmation_declared)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        declared,
      ]
    );
    const created = insertResult.rows[0];

    // 7. Run spam detection in the background (does not block the response).
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
    res.status(500).json({ error: 'Failed to create report' });
  }
});

// ============================================================
// POST /decline — user declines a report (writes a cool-down).
// ============================================================
router.post('/decline', auth, async (req, res) => {
  try {
    const { bug_fingerprint, device_fingerprint } = req.body || {};
    if (!bug_fingerprint) {
      return res.status(400).json({ error: 'bug_fingerprint is required' });
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
    res.status(500).json({ error: 'Failed to record decline' });
  }
});

// ============================================================
// GET /notifications — fetch the notification list.
// ============================================================
router.get('/notifications', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const role = req.query.role || 'reporter';
    const isAdmin = isAtLeast(req.user.role, 'admin');

    if ((role === 'admin' || role === 'both') && !isAdmin) {
      return res.status(403).json({ error: 'Admin permission required' });
    }

    const result = {};

    if (role === 'reporter' || role === 'both') {
      // Reports I sent that are resolved but not yet read.
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
      // Filter out fingerprints the user has muted.
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
      // Look at unhandled reports from others. If the admin set "don't
      // remind me about my own", exclude their own.
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
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// ============================================================
// POST /notifications/mark-all-read — batch mark as read (reporter).
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
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

// ============================================================
// POST /notifications/mute — mute by fingerprint or your own reports.
// ============================================================
router.post('/notifications/mute', auth, async (req, res) => {
  try {
    const { mute_target, target_value } = req.body || {};
    if (!['fingerprint', 'own_reports'].includes(mute_target)) {
      return res.status(400).json({
        error: 'mute_target must be fingerprint or own_reports',
      });
    }
    if (mute_target === 'fingerprint' && !target_value) {
      return res
        .status(400)
        .json({ error: 'target_value is required when mute_target=fingerprint' });
    }
    if (mute_target === 'own_reports' && target_value) {
      return res
        .status(400)
        .json({ error: 'target_value must be empty when mute_target=own_reports' });
    }
    await query(
      `INSERT INTO bug_report_notification_mutes (user_id, mute_target, target_value)
       VALUES ($1, $2, $3)`,
      [req.user.id, mute_target, target_value || null]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    logger.error('bug_report_mute_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to create mute' });
  }
});

// ============================================================
// GET / — list reports (user sees their own; admin can pass ?scope=all).
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
      return res.status(403).json({ error: 'Insufficient permissions' });
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
              bug_fingerprint, created_at, resolved_at, confirmation_declared
         FROM bug_reports
         ${where}
         ORDER BY created_at DESC
         ${limitOffset}`,
      args
    );
    res.json({ page, size, items: rows.rows });
  } catch (err) {
    logger.error('bug_report_list_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to list reports' });
  }
});

// ============================================================
// GET /spam-suspects — admin sees the spam suspect list.
// ============================================================
router.get('/spam-suspects', auth, async (req, res) => {
  try {
    if (!isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: 'Admin permission required' });
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
    res.status(500).json({ error: 'Failed to fetch spam suspects' });
  }
});

// ============================================================
// POST /spam-suspects/:id/confirm — admin confirms spam, triggers 24h block.
// ============================================================
router.post('/spam-suspects/:id/confirm', auth, async (req, res) => {
  try {
    if (!isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: 'Admin permission required' });
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
        .json({ error: 'suspect not found or no longer pending' });
    }

    await query(
      `INSERT INTO bug_report_spam_blocks (user_id, reason, blocked_by)
       VALUES ($1, $2, $3)`,
      [result.rows[0].user_id, reason, req.user.id]
    );

    res.json({ ok: true });
  } catch (err) {
    logger.error('bug_report_spam_confirm_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to confirm spam' });
  }
});

// ============================================================
// POST /spam-suspects/:id/dismiss — admin dismisses a suspect.
// ============================================================
router.post('/spam-suspects/:id/dismiss', auth, async (req, res) => {
  try {
    if (!isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: 'Admin permission required' });
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
        .json({ error: 'suspect not found or no longer pending' });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('bug_report_spam_dismiss_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to dismiss suspect' });
  }
});

// ============================================================
// GET /:id — single report (user sees their own; admin sees all).
// ============================================================
router.get('/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const isAdmin = isAtLeast(req.user.role, 'admin');
    const result = await query(`SELECT * FROM bug_reports WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }
    const report = result.rows[0];
    if (!isAdmin && report.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    res.json(report);
  } catch (err) {
    logger.error('bug_report_get_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

// ============================================================
// PATCH /:id/status — admin updates the processing status.
// ============================================================
router.patch('/:id/status', auth, async (req, res) => {
  try {
    if (!isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: 'Admin permission required' });
    }
    const id = parseInt(req.params.id, 10);
    const { status, status_reason, status_reason_note } = req.body || {};

    const validStatuses = ['new', 'triaged', 'in_progress', 'fixed', 'wontfix'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${validStatuses.join(' / ')}` });
    }
    // Mirror the bug_reports_status_reason_check DB constraint (db/017). Without
    // this, an out-of-enum status_reason trips the constraint at UPDATE time and
    // surfaces as a bare 500; validating here returns an actionable 400 instead.
    if (status_reason && !ALLOWED_STATUS_REASONS.includes(status_reason)) {
      return res.status(400).json({
        error: `status_reason must be one of ${ALLOWED_STATUS_REASONS.join(' / ')} (or omitted)`,
      });
    }
    if (status === 'wontfix' && !status_reason) {
      return res
        .status(400)
        .json({ error: 'status_reason is required when status=wontfix' });
    }
    if (status_reason === 'wontfix_other' && !status_reason_note) {
      return res
        .status(400)
        .json({ error: 'a note is required when status_reason=wontfix_other' });
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
      return res.status(404).json({ error: 'Report not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('bug_report_status_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ============================================================
// POST /:id/mark-notified — user marks the notification as read.
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
        .json({ error: 'Report not found or not yet resolved' });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('bug_report_mark_notified_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

export default router;
