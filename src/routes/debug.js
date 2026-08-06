import { Router } from 'express';
import logger from '../utils/logger.js';
import { runInstallCheckAlerts } from '../jobs/install-check-alerts.js';

// v1.17.85 observability: beacon triggers (emitted during the upgrade flow, not a
// self-check report). When writing install_check_logs the client_version is
// forced to NULL so sentinel values don't pollute the version column.
//
// Extracted as a named const with a trailing underscore prefix:
//   - Future kind names (e.g. upgrade_failed_dirty_tree) won't be
//     accidentally classified as beacons.
//   - Existing _step-level reports (upgrade_npm_install_failed /
//     upgrade_dirty_tree) won't false-match.
const BEACON_TRIGGER_EXACT = new Set(['install_started', 'update_started']);
const BEACON_TRIGGER_PREFIXES = ['install_failed_', 'update_failed_', 'upgrade_failed_'];

function isBeaconTrigger(trigger) {
  if (!trigger || typeof trigger !== 'string') return false;
  if (BEACON_TRIGGER_EXACT.has(trigger)) return true;
  return BEACON_TRIGGER_PREFIXES.some((p) => trigger.startsWith(p));
}

/**
 * Debug routes — receive client-side self-check uploads.
 *
 * POST /api/debug/install-check
 *   Body: { ts, trigger, client_version, platform, node_version, machine, checks, summary }
 *   Auth: regular user API key.
 *   Stores into install_check_logs; the admin dashboard uses it to inspect
 *   each user's install health.
 */
export function createDebugRouter({ query, auth, onReportStored }) {
  const router = Router();
  // Injected so the wiring is testable without a database. In production this is
  // the real evaluator, reading the same pool the route writes through.
  // `query` alone no longer makes the evaluator database-free: when it has new
  // failures to announce it opens a transaction on the module-level pool. A route
  // test that wants no database at all has to pass `onReportStored`.
  const evaluateAlerts = onReportStored || (() => runInstallCheckAlerts({ query }));

  router.post('/install-check', auth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'unauthenticated' });

      const body = req.body || {};
      // v1.17.78 (observability): accept install_started / install_failed_* beacon
      // payloads — they are sent earlier than the self-check report, so admin
      // at least sees that the user attempted an install. Only ts is required;
      // checks / summary may be omitted.
      if (!body.ts) {
        return res.status(400).json({ error: 'missing ts' });
      }
      const ts = new Date(body.ts);
      if (Number.isNaN(ts.getTime())) {
        return res.status(400).json({ error: 'invalid ts' });
      }
      // checks is optional; if supplied it must be an array with valid status values.
      if (body.checks !== undefined) {
        if (!Array.isArray(body.checks)) {
          return res.status(400).json({ error: 'checks must be array' });
        }
        const validStatus = new Set(['pass', 'warn', 'fail']);
        if (!body.checks.every((c) => c && validStatus.has(c.status))) {
          return res.status(400).json({ error: 'invalid check status' });
        }
      }
      // summary is optional; if supplied it must be an object.
      if (body.summary !== undefined && (typeof body.summary !== 'object' || Array.isArray(body.summary))) {
        return res.status(400).json({ error: 'summary must be object' });
      }
      const checks = body.checks || [];
      const summary = body.summary || { pass: 0, warn: 0, fail: 0 };
      // Cap oversized payloads to prevent abuse (typical ~2KB; cap at 64KB).
      const fullLog = JSON.stringify(body);
      if (fullLog.length > 64 * 1024) {
        return res.status(413).json({ error: 'payload too large' });
      }

      // v1.17.83 — Postgres JSONB strictly rejects NUL bytes; client-side
      // mojibake / dirty env vars introduce them. Strip null bytes before
      // insert; other control characters are JSON-spec-allowed and don't
      // need changing.
      // Real case: vin-windows-test round-6 server log saw consecutive 5xx
      // "unsupported Unicode escape sequence" — same payload containing a
      // null byte being retransmitted repeatedly (paired with client-side
      // retrySpool cap so both ends guard symmetrically).
      const sanitizeNullBytes = (s) => (typeof s === 'string' ? s.replace(/\x00/g, '').replace(/\\u0000/g, '') : s);

      // v1.17.85 observability: for beacon triggers (emitted mid-upgrade, not
      // self-check reports), client_version is unreliable — early in the
      // upgrade the client uses placeholder sentinels "install-script" /
      // "update-script", and on failure it uses "unknown". Force NULL to
      // avoid polluting the client_version column or misleading the admin
      // last-version query into treating a sentinel as the latest version.
      //
      // install_check_logs still receives a row (the observability channel
      // stays complete); just with client_version NULL, so the last-version
      // query naturally only considers self-check reports (post_install /
      // manual / post_upgrade) with real versions.
      //
      // Beacon detection lives in isBeaconTrigger() at the top of the file
      // so future kind name changes don't false-match (reviewer I1 suggestion).
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

      // Alerting must never cost a report: the row is already committed, and a
      // failure here is logged rather than returned.
      try {
        await evaluateAlerts();
      } catch (err) {
        logger.error?.('install-check alert evaluation failed', { error: err?.message });
      }

      res.json({ ok: true });
    } catch (err) {
      logger.error?.('install-check write failed', { error: err?.message });
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}

export default createDebugRouter;
