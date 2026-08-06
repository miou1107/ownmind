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
 *
 * Write order, which is load-bearing:
 *   1. claim each new failure (conditional upsert, RETURNING) — only the rows
 *      this run actually claimed may be announced, so two overlapping sweeps
 *      cannot both announce the same failure;
 *   2. write the broadcast from exactly those claimed rows;
 *   3. if the broadcast write fails, release the claims and rethrow, so nothing
 *      ends up marked announced without a broadcast to show for it.
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
  ORDER BY l.user_id, l.machine, l.id DESC
`;
// Recency is l.id, not l.ts. ts is whatever the client put in the payload and is
// only validated as parseable, so a machine with a skewed clock (say, set to
// 2027) would upload one report that outranks every later one and could never
// announce a failure again. id is assigned by the server and only goes up.

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

// Claim a failure before announcing it. The WHERE clause on the conflict path
// is what makes two overlapping sweeps safe: both read the same known state and
// compute the same new failures, but only the one whose UPDATE actually matched
// an unannounced (or since-resolved) row gets a row back. An empty result means
// somebody else already announced this one, so it must not go in our broadcast.
// Same shape of defence as the SQLSTATE 23505 handling in
// src/jobs/nightly-upgrade-reminder.js, expressed as a conditional upsert.
const CLAIM_SQL = `
  INSERT INTO install_check_alert_state
    (user_id, machine, check_name, detail, announced_at, resolved_at)
  VALUES ($1, $2, $3, $4, NOW(), NULL)
  ON CONFLICT (user_id, machine, check_name)
  DO UPDATE SET detail = EXCLUDED.detail, announced_at = NOW(), resolved_at = NULL
  WHERE install_check_alert_state.announced_at IS NULL
     OR install_check_alert_state.resolved_at IS NOT NULL
  RETURNING user_id, machine, check_name
`;

// Undo a claim whose broadcast never got written. Clearing announced_at (rather
// than deleting the row) puts the key back in the state the evaluator reads as
// "never announced", so the next sweep tries again, while first_seen_at keeps
// recording when the problem actually started.
const RELEASE_CLAIM_SQL = `
  UPDATE install_check_alert_state
  SET announced_at = NULL
  WHERE user_id = $1 AND machine = $2 AND check_name = $3
`;

// Oldest super_admin, matching src/jobs/nightly-upgrade-reminder.js. Not "any
// super_admin": production has two, and only id 1 is the person who acts on this.
const SUPER_ADMIN_SQL = `SELECT id FROM users WHERE role = 'super_admin' ORDER BY id ASC LIMIT 1`;

// 48 hours, not seven days. severity='warning' with allow_snooze=FALSE makes
// the session-start hook force this into the AI's first sentence of every new
// conversation, and there is no cooldown on that path. Two days of that is a
// reminder; a week of it is something the reader learns to scroll past.
const BROADCAST_SQL = `
  INSERT INTO broadcast_messages
    (type, severity, title, body, target_users,
     allow_snooze, snooze_hours, cooldown_minutes, ends_at, is_auto, created_by)
  VALUES ('announcement', 'warning', $1, $2, $3,
          FALSE, 24, 1440, NOW() + INTERVAL '48 hours', TRUE, $4)
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

  // Read the recipient before claiming anything. If this lookup throws, no claim
  // exists yet and the next sweep starts from a clean state.
  const admin = await query(SUPER_ADMIN_SQL);

  // Claim first, then broadcast, and release on failure. Claiming first is what
  // stops two overlapping sweeps announcing the same failure twice; releasing on
  // failure is what stops a broadcast that never got written from silencing
  // those failures forever.
  const claimed = [];
  for (const failure of newFailures) {
    const claim = await query(CLAIM_SQL, [
      failure.user_id, failure.machine, failure.check_name, failure.detail,
    ]);
    if (claim.rowCount > 0) claimed.push(failure);
  }

  if (claimed.length === 0) {
    logger.info('install-check-alerts: every new failure was claimed by another run', {
      count: newFailures.length,
    });
    return { announced: 0, omitted: 0, broadcast_id: null };
  }

  if (admin.rowCount === 0) {
    logger.warn('install-check-alerts: no super_admin, state recorded but nothing announced', {
      count: claimed.length,
    });
    return { announced: claimed.length, omitted: 0, broadcast_id: null };
  }

  const adminId = admin.rows[0].id;
  const { title, body, omitted } = renderAlertMessage(claimed);

  let inserted;
  try {
    inserted = await query(BROADCAST_SQL, [title, body, [adminId], adminId]);
  } catch (err) {
    await releaseClaims(query, claimed);
    throw err;
  }

  logger.info('install-check-alerts announced', {
    count: claimed.length,
    omitted,
    broadcast_id: inserted.rows[0].id,
  });

  return { announced: claimed.length, omitted, broadcast_id: inserted.rows[0].id };
}

/**
 * Put claimed keys back so the next sweep re-announces them.
 * A release that itself fails is logged and never rethrown: the caller is about
 * to rethrow the broadcast error, which is the one worth reporting.
 */
async function releaseClaims(query, claimed) {
  for (const failure of claimed) {
    try {
      await query(RELEASE_CLAIM_SQL, [failure.user_id, failure.machine, failure.check_name]);
    } catch (releaseErr) {
      logger.error('install-check-alerts: could not release a claim after a failed broadcast', {
        user_id: failure.user_id,
        machine: failure.machine,
        check_name: failure.check_name,
        error: releaseErr.message,
      });
    }
  }
}

export default runInstallCheckAlerts;
