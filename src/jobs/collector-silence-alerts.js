// src/jobs/collector-silence-alerts.js
/**
 * Tell people when their usage collector has stopped, instead of waiting for
 * somebody to open the 系統設定 panel and notice.
 *
 * Runs once at startup and then daily. Unlike install-check-alerts, which is
 * driven by a report arriving, this condition changes with the clock: a machine
 * becomes newly silent because time passed, not because anything was uploaded.
 * So it does need a schedule.
 *
 * Two broadcasts per sweep at most:
 *   - one per affected person, addressed to them, carrying the repair;
 *   - one to the admin, listing everybody, carrying no repair because they
 *     cannot run it on somebody else's computer.
 *
 * Write order, which is load-bearing and copied from install-check-alerts:
 *   1. claim each newly silent machine (conditional upsert, RETURNING) — only
 *      the rows this run actually claimed may be announced, so two overlapping
 *      sweeps cannot both announce the same machine;
 *   2. write the broadcasts from exactly those claimed rows.
 *
 * Both steps run inside one transaction, so a claim without its broadcast is not
 * a state the database can be left in.
 */

import cron from 'node-cron';
import { query as defaultQuery, withTransaction as defaultWithTransaction } from '../utils/db.js';
import logger from '../utils/logger.js';
import { evaluateSilence } from '../lib/collector-silence.js';
import { renderMemberMessage, renderAdminMessage } from '../lib/collector-silence-message.js';

/**
 * Every heartbeat row, with the person's display name.
 *
 * Members with a tracking exemption in force are left out entirely: their usage
 * is not being counted by agreement, so a dead collector on their machine is not
 * a fault anybody needs telling about.
 */
const HEARTBEAT_SQL = `
  SELECT h.user_id,
         COALESCE(u.name, u.email) AS user_name,
         h.machine,
         h.tool,
         h.last_reported_at
  FROM collector_heartbeat h
  JOIN users u ON u.id = h.user_id
  WHERE NOT EXISTS (
          SELECT 1 FROM usage_tracking_exemption e
           WHERE e.user_id = h.user_id
             AND (e.expires_at IS NULL OR e.expires_at > NOW()))
`;

const KNOWN_STATE_SQL = `
  SELECT user_id, machine, stale_tools, announced_at, resolved_at, broadcast_id
  FROM collector_silence_alert_state
`;

// Resolving ends the notice as well as recording the recovery. Without the
// second statement somebody who repairs their machine keeps being told about it
// in the first sentence of every conversation until the broadcast expires.
const RESOLVE_SQL = `
  UPDATE collector_silence_alert_state
  SET resolved_at = NOW()
  WHERE user_id = $1 AND machine = $2
  RETURNING broadcast_id
`;

const END_BROADCAST_SQL = `
  UPDATE broadcast_messages
  SET ends_at = NOW()
  WHERE id = $1 AND (ends_at IS NULL OR ends_at > NOW())
`;

const UPDATE_DETAIL_SQL = `
  UPDATE collector_silence_alert_state
  SET stale_tools = $3, last_beat_at = $4
  WHERE user_id = $1 AND machine = $2
`;

// Claim a machine before announcing it. The WHERE clause on the conflict path is
// what makes two overlapping sweeps safe: both compute the same findings, but
// only the one whose UPDATE actually matched an unannounced (or since-resolved)
// row gets a row back. An empty result means somebody else already announced it.
const CLAIM_SQL = `
  INSERT INTO collector_silence_alert_state
    (user_id, machine, stale_tools, last_beat_at, announced_at, resolved_at)
  VALUES ($1, $2, $3, $4, NOW(), NULL)
  ON CONFLICT (user_id, machine)
  DO UPDATE SET stale_tools = EXCLUDED.stale_tools,
                last_beat_at = EXCLUDED.last_beat_at,
                announced_at = NOW(),
                resolved_at = NULL,
                broadcast_id = NULL
  WHERE collector_silence_alert_state.announced_at IS NULL
     OR collector_silence_alert_state.resolved_at IS NOT NULL
  RETURNING user_id, machine
`;

const RECORD_BROADCAST_SQL = `
  UPDATE collector_silence_alert_state
  SET broadcast_id = $3
  WHERE user_id = $1 AND machine = $2
`;

// Oldest super_admin, matching src/jobs/install-check-alerts.js. Not "any
// super_admin": production has two, and only the first is the person who acts.
const SUPER_ADMIN_SQL = `SELECT id FROM users WHERE role = 'super_admin' ORDER BY id ASC LIMIT 1`;

// 48 hours, un-snoozeable, matching install-check-alerts. severity='warning' with
// allow_snooze=FALSE makes the session-start hook force this into the AI's first
// sentence of every new conversation. Two days of that is a reminder; a week of
// it is something the reader learns to scroll past. Repairing the collector ends
// it sooner than that, via RESOLVE_SQL above.
const BROADCAST_SQL = `
  INSERT INTO broadcast_messages
    (type, severity, title, body, target_users,
     allow_snooze, snooze_hours, cooldown_minutes, ends_at, is_auto, created_by)
  VALUES ('announcement', 'warning', $1, $2, $3,
          FALSE, 24, 1440, NOW() + INTERVAL '48 hours', TRUE, $4)
  RETURNING id
`;

/**
 * Evaluate every heartbeat row and announce the machines that newly went quiet.
 *
 * @param {object} [deps]
 * @param {(sql: string, params?: Array) => Promise<import('pg').QueryResult>} [deps.query]
 * @param {(fn: (client: import('pg').PoolClient) => Promise<any>) => Promise<any>} [deps.withTransaction]
 * @param {() => Date} [deps.now] injectable clock, so the thresholds can be tested
 * @returns {Promise<{announced: number, resolved: number, broadcast_ids: number[]}>}
 */
export async function runCollectorSilenceAlerts({
  query = defaultQuery,
  withTransaction = defaultWithTransaction,
  now = () => new Date(),
} = {}) {
  const [beats, stateResult] = await Promise.all([
    query(HEARTBEAT_SQL),
    query(KNOWN_STATE_SQL),
  ]);

  const { newSilences, resolved, detailChanges } = evaluateSilence({
    rows: beats.rows,
    knownState: stateResult.rows,
    now: now(),
  });

  // Deliberately outside the transaction below, for the same reasons as
  // install-check-alerts: these touch keys nobody is about to announce, each one
  // stands alone, and they must still run on the common path where there is
  // nothing new and no transaction is opened at all.
  for (const row of resolved) {
    const done = await query(RESOLVE_SQL, [row.user_id, row.machine]);
    const broadcastId = done.rows?.[0]?.broadcast_id;
    if (broadcastId) await query(END_BROADCAST_SQL, [broadcastId]);
  }
  for (const row of detailChanges) {
    await query(UPDATE_DETAIL_SQL, [row.user_id, row.machine, row.stale_tools, row.last_beat_at]);
  }

  if (newSilences.length === 0) {
    return { announced: 0, resolved: resolved.length, broadcast_ids: [] };
  }

  // Read the recipient before opening the transaction. If this lookup throws, no
  // claim exists yet and the next sweep starts from a clean state.
  const admin = await query(SUPER_ADMIN_SQL);

  // Claims are taken in a fixed order. Each one holds its row lock until the
  // transaction ends, so two sweeps locking the same pair of keys in opposite
  // orders would deadlock and Postgres would kill one of them.
  const claimOrder = [...newSilences].sort((a, b) => (
    a.user_id - b.user_id || String(a.machine).localeCompare(String(b.machine))
  ));

  const { result, log } = await withTransaction(async (client) => {
    const claimed = [];

    for (const silence of claimOrder) {
      const claim = await client.query(CLAIM_SQL, [
        silence.user_id, silence.machine, silence.stale_tools, silence.last_beat_at,
      ]);
      if (claim.rowCount > 0) claimed.push(silence);
    }

    if (claimed.length === 0) {
      return {
        result: { announced: 0, resolved: resolved.length, broadcast_ids: [] },
        log: {
          level: 'info',
          message: 'collector-silence: every finding was claimed by another run',
          meta: { count: newSilences.length },
        },
      };
    }

    const broadcastIds = [];

    // One message per affected person, addressed to them. Written before the
    // admin's, so if the body of one throws, the transaction rolls back the
    // claims and the next sweep retries rather than leaving people unannounced.
    const byUser = new Map();
    for (const silence of claimed) {
      if (!byUser.has(silence.user_id)) byUser.set(silence.user_id, []);
      byUser.get(silence.user_id).push(silence);
    }

    for (const [userId, silences] of byUser) {
      const { title, body } = renderMemberMessage(silences);
      const inserted = await client.query(BROADCAST_SQL, [title, body, [userId], userId]);
      const broadcastId = inserted.rows[0].id;
      broadcastIds.push(broadcastId);
      // Recorded per machine, so repairing one of a person's two computers ends
      // only what it should. Both machines share the message; ending it when the
      // first is fixed is the accepted cost of not writing two.
      for (const silence of silences) {
        await client.query(RECORD_BROADCAST_SQL, [userId, silence.machine, broadcastId]);
      }
    }

    // The admin's copy. Having no super_admin is not a failure: the members were
    // told, and rolling the claims back would leave every later sweep
    // re-evaluating the same machines forever.
    if (admin.rowCount === 0) {
      return {
        result: { announced: claimed.length, resolved: resolved.length, broadcast_ids: broadcastIds },
        log: {
          level: 'warn',
          message: 'collector-silence: no super_admin, members told but nobody was given the summary',
          meta: { count: claimed.length },
        },
      };
    }

    const adminId = admin.rows[0].id;
    const summary = renderAdminMessage(claimed);
    const adminBroadcast = await client.query(
      BROADCAST_SQL, [summary.title, summary.body, [adminId], adminId]
    );
    broadcastIds.push(adminBroadcast.rows[0].id);

    return {
      result: { announced: claimed.length, resolved: resolved.length, broadcast_ids: broadcastIds },
      log: {
        level: 'info',
        message: 'collector-silence announced',
        meta: { count: claimed.length, omitted: summary.omitted, broadcast_ids: broadcastIds },
      },
    };
  });

  // After the commit, not inside it: a line written from inside the transaction
  // survives a rollback that undid everything it describes.
  if (log.level === 'warn') logger.warn(log.message, log.meta);
  else logger.info(log.message, log.meta);

  return result;
}

/** Daily at 04:00 Asia/Taipei, after the nightly jobs and before the working day. */
export function startCollectorSilenceJob() {
  cron.schedule('0 4 * * *', () => {
    runCollectorSilenceAlerts().catch((err) =>
      logger.error('collector-silence cron failed', { error: err.message }));
  }, { timezone: 'Asia/Taipei' });
}

export default runCollectorSilenceAlerts;
