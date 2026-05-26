import { Router } from 'express';
import { query as defaultQuery } from '../utils/db.js';
import defaultAuth from '../middleware/auth.js';
import defaultAdminAuth, { superAdminAuth as defaultSuperAdminAuth } from '../middleware/adminAuth.js';
import logger from '../utils/logger.js';
import { filterVisibleBroadcasts, filterInjectable } from '../lib/broadcast-filter.js';

const VALID_TYPES = new Set(['announcement', 'upgrade_reminder', 'maintenance', 'rule_change']);
const VALID_SEVERITY = new Set(['info', 'warning', 'critical']);

/**
 * coerceNum — unifies JSON-supplied number / numeric string (e.g. "24") into
 * a number; invalid input or NaN falls back to default. Avoids the
 * Number.isFinite("24") === false pitfall.
 */
function coerceNum(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Broadcast system — admin-published general broadcasts plus user-side
 * fetch / snooze / dismiss.
 *
 * Admin:
 *   POST   /api/broadcast/admin            super_admin   create
 *   GET    /api/broadcast/admin            admin+        list (including history)
 *   PATCH  /api/broadcast/admin/:id        super_admin   update ends_at / target_users
 *   DELETE /api/broadcast/admin/:id        super_admin   revoke (soft delete = ends_at=NOW())
 *
 * User:
 *   GET    /api/broadcast/active?tool=X    all (authed)             fetch broadcasts to show now
 *   POST   /api/broadcast/dismiss          all                       { broadcast_id, tool, snooze_hours? }
 */
export function createBroadcastRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const auth = deps.auth ?? defaultAuth;
  const adminAuth = deps.adminAuth ?? defaultAdminAuth;
  const superAdminAuth = deps.superAdminAuth ?? defaultSuperAdminAuth;
  const now = deps.now ?? (() => new Date());

  const router = Router();

  // ============================================================
  // Admin: create a broadcast.
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
      logger.error('broadcast create failed', { error: err.message });
      res.status(500).json({ error: 'Failed to create broadcast: ' + err.message });
    }
  });

  // ============================================================
  // Admin: list broadcasts (default active=true; use ?include_ended=true
  // for the full history).
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
      logger.error('broadcast list failed', { error: err.message });
      res.status(500).json({ error: 'Failed to list broadcasts' });
    }
  });

  // ============================================================
  // Admin: update / revoke.
  // ============================================================
  router.patch('/admin/:id', superAdminAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const body = req.body || {};
      const fields = [];
      const params = [];
      if (body.ends_at !== undefined) {
        // null clears; other values must be parseable.
        let endsAt = null;
        if (body.ends_at !== null) {
          endsAt = new Date(body.ends_at);
          if (!Number.isFinite(endsAt.getTime())) {
            return res.status(400).json({ error: 'ends_at has invalid format' });
          }
        }
        params.push(endsAt); fields.push(`ends_at = $${params.length}`);
      }
      if (body.target_users !== undefined) {
        let val = null;
        if (Array.isArray(body.target_users) && body.target_users.length > 0) {
          for (const uid of body.target_users) {
            if (!Number.isInteger(uid) || uid <= 0) {
              return res.status(400).json({ error: 'target_users must be an array of positive integers' });
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
      logger.error('broadcast update failed', { error: err.message });
      res.status(500).json({ error: 'Failed to update broadcast: ' + err.message });
    }
  });

  router.delete('/admin/:id', superAdminAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

      // Check is_auto first — auto-managed broadcasts are controlled by the
      // nightly job and may not be manually revoked (the job's active-only
      // check would re-create them on the next run, creating a meaningless loop).
      const check = await query(`SELECT is_auto FROM broadcast_messages WHERE id = $1`, [id]);
      if (check.rowCount === 0) return res.status(404).json({ error: 'not found' });
      if (check.rows[0].is_auto) {
        return res.status(400).json({
          error: 'auto-managed broadcasts cannot be manually revoked (managed by the nightly job)'
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
      logger.error('broadcast revoke failed', { error: err.message });
      res.status(500).json({ error: 'Failed to revoke broadcast: ' + err.message });
    }
  });

  // ============================================================
  // User: fetch broadcasts to display now.
  // ============================================================
  router.get('/active', auth, async (req, res) => {
    try {
      const tool = String(req.query.tool || '').trim();
      if (!tool) return res.status(400).json({ error: 'tool is required' });
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
      logger.error('broadcast/active query failed', { error: err.message });
      res.status(500).json({ error: 'Failed to query broadcasts' });
    }
  });

  // ============================================================
  // User: dismiss / snooze.
  // ============================================================
  router.post('/dismiss', auth, async (req, res) => {
    try {
      const body = req.body || {};
      const broadcast_id = parseInt(body.broadcast_id, 10);
      const tool = String(body.tool || '').trim();
      if (!Number.isFinite(broadcast_id) || !tool) {
        return res.status(400).json({ error: 'broadcast_id and tool are required' });
      }

      // Visibility check (critical fix): only allow dismiss when the user
      // can currently see this broadcast. Otherwise users could pre-dismiss
      // future targeted broadcasts and bypass admin targeting guarantees.
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
        return res.status(404).json({ error: 'broadcast does not exist or is not in your visible set' });
      }

      const hasSnoozeArg = body.snooze_hours !== undefined && body.snooze_hours !== null;
      const parsedSnoozeHours = hasSnoozeArg ? Number(body.snooze_hours) : undefined;
      const isSnooze = hasSnoozeArg && Number.isFinite(parsedSnoozeHours) && parsedSnoozeHours > 0;
      if (hasSnoozeArg && !isSnooze) {
        return res.status(400).json({ error: 'snooze_hours must be a positive number' });
      }
      if (isSnooze && !bc.allow_snooze) {
        return res.status(400).json({ error: 'this broadcast does not allow snooze (use dismiss)' });
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
      logger.error('broadcast/dismiss failed', { error: err.message });
      res.status(500).json({ error: 'dismiss failed: ' + err.message });
    }
  });

  // ============================================================
  // MCP: fetch "broadcasts to inject right now" — pinged on every
  // ownmind_* tool call.
  //
  // This endpoint owns "timing", not "visibility":
  //   1. Upsert user_tool_last_seen (used for first-of-day / 4h gap detection).
  //   2. Compute is_first_of_day (Asia/Taipei) and is_long_gap (> 4h).
  //   3. filterVisibleBroadcasts → filterInjectable (forceInject when first
  //      or long gap).
  //   4. Mark last_injected_at on user_broadcast_state.
  //   5. Return { broadcasts: [...] } for the MCP client to prepend to the
  //      tool's response text.
  //
  // Server-side side effects only; the MCP client just prepends the text it
  // receives.
  // ============================================================
  router.post('/inject', auth, async (req, res) => {
    try {
      const tool = String((req.body && req.body.tool) || req.query.tool || '').trim();
      if (!tool) return res.status(400).json({ error: 'tool is required' });
      const client_version = (req.body && req.body.client_version)
        || req.query.client_version
        || req.headers['x-ownmind-version']
        || null;

      const nowTs = now();
      const user_id = req.user.id;

      // 1. Fetch the previous "seen" (used for first-of-day / 4h gap detection).
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

      // 2. Upsert user_tool_last_seen (even if nothing to inject, still update).
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

      // 4. Mark last_injected_at for each (non-blocking-ish, but Promise.all
      //    ensures completion before sending the response).
      const ids = injectable.map((bc) => bc.id);
      await query(
        `INSERT INTO user_broadcast_state (user_id, broadcast_id, tool, last_injected_at)
         SELECT $1, id, $2, $3 FROM unnest($4::int[]) AS id
         ON CONFLICT (user_id, broadcast_id, tool) DO UPDATE
           SET last_injected_at = EXCLUDED.last_injected_at`,
        [user_id, tool, nowTs, ids]
      );

      // 5. Return — only the fields the MCP client needs; do not leak internal state.
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
      logger.error('broadcast/inject failed', { error: err.message });
      res.status(500).json({ error: 'inject failed: ' + err.message });
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
 * Validate the POST /admin payload.
 * Note: string-numbers ("24") are coerced via Number() first to avoid
 * spuriously rejecting JSON-integer strings.
 * Also validates that starts_at / ends_at parse and that ends_at > starts_at.
 */
export function validateBroadcastPayload(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (!VALID_TYPES.has(body.type)) return `type must be one of ${[...VALID_TYPES].join(' / ')}`;
  if (body.severity && !VALID_SEVERITY.has(body.severity)) {
    return `severity must be one of ${[...VALID_SEVERITY].join(' / ')}`;
  }
  if (typeof body.title !== 'string' || body.title.trim().length === 0) return 'title is required';
  if (body.title.length > 200) return 'title must not exceed 200 characters';
  if (typeof body.body !== 'string' || body.body.trim().length === 0) return 'body is required';
  if (body.body.length > 2000) return 'body must not exceed 2000 characters';
  if (body.target_users !== undefined && body.target_users !== null) {
    if (!Array.isArray(body.target_users)) return 'target_users must be an array';
    for (const uid of body.target_users) {
      if (!Number.isInteger(uid) || uid <= 0) return 'target_users must be an array of positive integers';
    }
  }
  if (body.snooze_hours !== undefined && body.snooze_hours !== null) {
    const n = Number(body.snooze_hours);
    if (!Number.isFinite(n) || n <= 0) return 'snooze_hours must be a positive number';
  }
  if (body.cooldown_minutes !== undefined && body.cooldown_minutes !== null) {
    const n = Number(body.cooldown_minutes);
    if (!Number.isFinite(n) || n < 0) return 'cooldown_minutes must be 0 or a positive number';
  }

  // Date validation: parseable + ends_at > starts_at.
  const parseDate = (v) => {
    if (v === undefined || v === null || v === '') return { ok: true, date: null };
    if (v instanceof Date) {
      return Number.isFinite(v.getTime()) ? { ok: true, date: v } : { ok: false };
    }
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? { ok: true, date: d } : { ok: false };
  };
  const sp = parseDate(body.starts_at);
  if (!sp.ok) return 'starts_at has invalid format (expected ISO 8601 or Date)';
  const ep = parseDate(body.ends_at);
  if (!ep.ok) return 'ends_at has invalid format (expected ISO 8601 or Date)';
  if (sp.date && ep.date && ep.date.getTime() <= sp.date.getTime()) {
    return 'ends_at must be later than starts_at';
  }

  return null;
}

export default createBroadcastRouter();
