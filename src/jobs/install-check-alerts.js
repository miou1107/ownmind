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
 *   2. write the broadcast from exactly those claimed rows.
 *
 * Both steps run inside one transaction, so a claim without its broadcast is not
 * a state the database can be left in. Undoing the claims from the client (the
 * previous design) could not cover the case where a claim commits server-side
 * and the response is then lost: the client sees a failure, holds no record of
 * the claim, and the row stays marked announced with nothing to show for it.
 * ROLLBACK is decided by the server, which is the only place that knows.
 */

import { query as defaultQuery, withTransaction as defaultWithTransaction } from '../utils/db.js';
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

/**
 * Evaluate the stored self-check reports and announce what is newly failing.
 *
 * @param {object} [deps]
 * @param {(sql: string, params?: Array) => Promise<import('pg').QueryResult>} [deps.query]
 *   Runs one statement outside any transaction. Used for the reads and for the
 *   resolve / detail-change updates, which are independent of the claim pair.
 * @param {(fn: (client: import('pg').PoolClient) => Promise<any>) => Promise<any>} [deps.withTransaction]
 *   Runs `fn` against a dedicated client wrapped in BEGIN / COMMIT, rolling back
 *   on any throw. Injectable so the claim-and-announce pair can be tested with a
 *   fake client that can simulate a rollback. Callers are not expected to pass
 *   it; the default is the real pool transaction. Named after the dependency it
 *   stands for, the same way `src/routes/setup.js` injects it.
 * @returns {Promise<{announced: number, omitted: number, broadcast_id: number|null}>}
 */
export async function runInstallCheckAlerts({
  query = defaultQuery,
  withTransaction = defaultWithTransaction,
} = {}) {
  const [reportsResult, stateResult] = await Promise.all([
    query(LATEST_REPORTS_SQL),
    query(KNOWN_STATE_SQL),
  ]);

  const { newFailures, resolved, detailChanges } = evaluateFailures({
    reports: reportsResult.rows,
    knownState: stateResult.rows,
  });

  // Deliberately outside the transaction below. These two updates are not part
  // of the claim-and-announce pair: they touch keys nobody is about to announce,
  // each one stands alone, and they must still run on the far more common path
  // where there is nothing new to announce and no transaction is opened at all.
  // Folding them in would only make an unrelated failure discard them and would
  // hold a pool client open for writes that never needed one.
  for (const row of resolved) {
    await query(RESOLVE_SQL, [row.user_id, row.machine, row.check_name]);
  }
  for (const row of detailChanges) {
    await query(UPDATE_DETAIL_SQL, [row.user_id, row.machine, row.check_name, row.detail]);
  }

  if (newFailures.length === 0) {
    return { announced: 0, omitted: 0, broadcast_id: null };
  }

  // Read the recipient before opening the transaction. If this lookup throws, no
  // claim exists yet and the next sweep starts from a clean state; keeping it
  // out also keeps the transaction down to the writes that must agree.
  const admin = await query(SUPER_ADMIN_SQL);

  // Claim first, then broadcast, both on the same connection inside one
  // transaction. Claiming first is what stops two overlapping sweeps announcing
  // the same failure twice: the second sweep's conditional upsert waits for the
  // first to commit and then matches nothing. The transaction is what stops a
  // claim from outliving the broadcast it was made for — including the case
  // where the failure is a lost response rather than a rejected statement,
  // which no client-side undo can see.
  //
  // The claims are taken in a fixed order. Each one now holds its row lock until
  // the transaction ends, instead of for a single auto-committed statement, so
  // two sweeps that lock the same pair of keys in opposite orders would deadlock
  // and Postgres would kill one of them. The order of `newFailures` follows the
  // `checks` array the client uploaded, which is to say it is decided outside
  // this server; sorting by the key itself takes that decision back.
  const claimOrder = [...newFailures].sort((a, b) => (
    a.user_id - b.user_id
    || String(a.machine).localeCompare(String(b.machine))
    || String(a.check_name).localeCompare(String(b.check_name))
  ));

  const { result, log } = await withTransaction(async (client) => {
    const claimed = [];

    for (const failure of claimOrder) {
      const claim = await client.query(CLAIM_SQL, [
        failure.user_id, failure.machine, failure.check_name, failure.detail,
      ]);
      if (claim.rowCount > 0) claimed.push(failure);
    }

    if (claimed.length === 0) {
      return {
        result: { announced: 0, omitted: 0, broadcast_id: null },
        log: {
          level: 'info',
          message: 'install-check-alerts: every new failure was claimed by another run',
          meta: { count: newFailures.length },
        },
      };
    }

    // The one place a claim is allowed to outlive its broadcast, deliberately.
    // Returning normally here COMMITs the claims with nothing announced, because
    // having no recipient is not a failure: rolling them back would leave every
    // later sweep re-evaluating the same failures forever.
    if (admin.rowCount === 0) {
      return {
        result: { announced: claimed.length, omitted: 0, broadcast_id: null },
        log: {
          level: 'warn',
          message: 'install-check-alerts: no super_admin, state recorded but nothing announced',
          meta: { count: claimed.length },
        },
      };
    }

    const adminId = admin.rows[0].id;
    const { title, body, omitted } = renderAlertMessage(claimed);
    const inserted = await client.query(BROADCAST_SQL, [title, body, [adminId], adminId]);

    return {
      result: { announced: claimed.length, omitted, broadcast_id: inserted.rows[0].id },
      log: {
        level: 'info',
        message: 'install-check-alerts announced',
        meta: { count: claimed.length, omitted, broadcast_id: inserted.rows[0].id },
      },
    };
  });

  // Logging happens after the commit, not inside it. A line written from inside
  // the transaction survives a rollback that undid everything it describes,
  // which is exactly the kind of record that sends the next reader hunting for
  // a broadcast that does not exist.
  // Literal call sites, not logger[log.level]: a level that is not a method
  // would throw here, after the commit, and turn a run that fully succeeded into
  // one the caller records as failed.
  if (log.level === 'warn') logger.warn(log.message, log.meta);
  else logger.info(log.message, log.meta);

  return result;
}

export default runInstallCheckAlerts;
