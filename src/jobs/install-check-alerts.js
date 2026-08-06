// src/jobs/install-check-alerts.js
/**
 * Announce new install-check failures to the super admin.
 *
 * Runs after a self-check report is stored, and once at server startup so the
 * reports already in the table are evaluated rather than waiting for each
 * machine to check in again. The state table makes both paths idempotent.
 *
 * There is deliberately no cron: the set of failing checks changes only when a
 * new report arrives, so a nightly pass would add up to 24 hours of delay and a
 * second code path for no gain.
 */

import { query as defaultQuery } from '../utils/db.js';
import logger from '../utils/logger.js';
import { evaluateFailures } from '../lib/install-check-alerts.js';
import { renderAlertMessage } from '../lib/install-check-alert-message.js';

// One row per (user, machine): the newest report that carries a checks array.
// Beacon rows (install_started and friends) are emitted before the checks run
// and carry none; letting one win would mark every open problem resolved at the
// start of the next upgrade.
const LATEST_REPORTS_SQL = `
  SELECT DISTINCT ON (l.user_id, l.machine)
         l.user_id,
         COALESCE(u.name, u.email) AS user_name,
         l.machine,
         l.client_version,
         l.full_log->'checks'      AS checks
  FROM install_check_logs l
  JOIN users u ON u.id = l.user_id
  WHERE l.machine IS NOT NULL
    AND jsonb_typeof(l.full_log->'checks') = 'array'
    AND jsonb_array_length(l.full_log->'checks') > 0
  ORDER BY l.user_id, l.machine, l.ts DESC
`;

const KNOWN_STATE_SQL = `
  SELECT user_id, machine, check_name, detail, announced_at, resolved_at
  FROM install_check_alert_state
`;

const RESOLVE_SQL = `
  UPDATE install_check_alert_state
  SET resolved_at = NOW()
  WHERE user_id = $1 AND machine = $2 AND check_name = $3
`;

const UPDATE_DETAIL_SQL = `
  UPDATE install_check_alert_state
  SET detail = $4
  WHERE user_id = $1 AND machine = $2 AND check_name = $3
`;

const ANNOUNCE_SQL = `
  INSERT INTO install_check_alert_state
    (user_id, machine, check_name, detail, announced_at, resolved_at)
  VALUES ($1, $2, $3, $4, NOW(), NULL)
  ON CONFLICT (user_id, machine, check_name)
  DO UPDATE SET detail = EXCLUDED.detail, announced_at = NOW(), resolved_at = NULL
`;

// Oldest super_admin, matching src/jobs/nightly-upgrade-reminder.js. Not "any
// super_admin": production has two, and only id 1 is the person who acts on this.
const SUPER_ADMIN_SQL = `SELECT id FROM users WHERE role = 'super_admin' ORDER BY id ASC LIMIT 1`;

const BROADCAST_SQL = `
  INSERT INTO broadcast_messages
    (type, severity, title, body, target_users,
     allow_snooze, snooze_hours, cooldown_minutes, ends_at, is_auto, created_by)
  VALUES ('announcement', 'warning', $1, $2, $3,
          FALSE, 24, 1440, NOW() + INTERVAL '7 days', TRUE, $4)
  RETURNING id
`;

export async function runInstallCheckAlerts({ query = defaultQuery } = {}) {
  const [reportsResult, stateResult] = await Promise.all([
    query(LATEST_REPORTS_SQL),
    query(KNOWN_STATE_SQL),
  ]);

  const { newFailures, resolved, detailChanges } = evaluateFailures({
    reports: reportsResult.rows,
    knownState: stateResult.rows,
  });

  for (const row of resolved) {
    await query(RESOLVE_SQL, [row.user_id, row.machine, row.check_name]);
  }
  for (const row of detailChanges) {
    await query(UPDATE_DETAIL_SQL, [row.user_id, row.machine, row.check_name, row.detail]);
  }

  if (newFailures.length === 0) {
    return { announced: 0, omitted: 0, broadcast_id: null };
  }

  for (const failure of newFailures) {
    await query(ANNOUNCE_SQL, [
      failure.user_id, failure.machine, failure.check_name, failure.detail,
    ]);
  }

  const admin = await query(SUPER_ADMIN_SQL);
  if (admin.rowCount === 0) {
    logger.warn('install-check-alerts: no super_admin, state recorded but nothing announced', {
      count: newFailures.length,
    });
    return { announced: newFailures.length, omitted: 0, broadcast_id: null };
  }

  const adminId = admin.rows[0].id;
  const { title, body, omitted } = renderAlertMessage(newFailures);
  const inserted = await query(BROADCAST_SQL, [title, body, [adminId], adminId]);

  logger.info('install-check-alerts announced', {
    count: newFailures.length,
    omitted,
    broadcast_id: inserted.rows[0].id,
  });

  return { announced: newFailures.length, omitted, broadcast_id: inserted.rows[0].id };
}

export default runInstallCheckAlerts;
