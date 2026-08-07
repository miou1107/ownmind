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
 * ## Where each decision is made
 *
 * `evaluateSilence` answers "which machines are broken right now". **Which of
 * those to announce is decided by SQL**, in CLAIM_SQL below, because it is also
 * the question two concurrent sweeps must not both answer yes to. Keeping it in
 * one place means the answer always comes from the copy that holds a row lock.
 *
 * Order of writes in a sweep:
 *   1. record every current silence (SIGHTING_SQL) — idempotent, no announcing;
 *   2. claim and announce, inside one transaction, so a claim cannot outlive the
 *      broadcast it was made for;
 *   3. resolve what recovered, and drop sightings that healed unconfirmed.
 *
 * Step 3 is last on purpose. It used to run first, and a single failing UPDATE
 * there aborted the sweep before anything was announced — every day, for as long
 * as the bad row existed. Nothing about a recovery needs to be written before a
 * different machine's break is announced.
 */

import cron from 'node-cron';
import { query as defaultQuery, withTransaction as defaultWithTransaction } from '../utils/db.js';
import logger from '../utils/logger.js';
import { evaluateSilence } from '../lib/collector-silence.js';
import { renderMemberMessage, renderAdminMessage } from '../lib/collector-silence-message.js';

/**
 * How long a machine must have been observed broken before anybody is told.
 *
 * A computer that was switched off for a fortnight comes back with one fresh MCP
 * heartbeat against several stale scanner rows, and stays in that state until the
 * scanner's next run: half an hour on macOS and systemd, **two hours on Windows**
 * (`scripts/windows/register-scanner-task.ps1`), and longer still on a laptop
 * running on battery, which Task Scheduler defers by default. A sweep landing in
 * that window would send an un-snoozeable two-day notice about a machine that is
 * fine — and the startup sweep runs whenever the server is deployed, which is
 * during the working day.
 *
 * Six hours costs a real finding one night. The incident this feature exists for
 * ran twenty days.
 *
 * Exported so the tests can assert it against the scanner's actual schedules
 * rather than against a copy of this number.
 */
export const CONFIRM_HOURS = 6;

/**
 * How long before a machine that is still broken is mentioned again.
 *
 * The broadcast expires after 48 hours and the state row stays announced, so
 * without this a machine nobody fixed is never raised again — which is the state
 * this feature was built to end. Fortnightly is rare enough not to become
 * scenery, and comfortably longer than the 48 hours a notice itself lives, so a
 * machine is never announced again while its previous notice is still up.
 */
export const REANNOUNCE_DAYS = 14;

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

/**
 * Record that this machine is broken, without telling anybody yet.
 *
 * Runs for every current silence on every sweep, so it doubles as the update that
 * keeps `stale_tools` current when a silence widens. There is deliberately no
 * separate detail-update statement: one statement that always runs cannot drift
 * out of step with the finding, and it has no branch that goes untested.
 *
 * `first_seen_at` is reset only when the previous finding had been resolved, so a
 * machine that breaks a second time waits out the confirmation window again while
 * one that has been broken all along does not have its clock pushed back forever.
 */
const SIGHTING_SQL = `
  INSERT INTO collector_silence_alert_state (user_id, machine, stale_tools, last_beat_at)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (user_id, machine) DO UPDATE
  SET stale_tools   = EXCLUDED.stale_tools,
      last_beat_at  = EXCLUDED.last_beat_at,
      first_seen_at = CASE WHEN collector_silence_alert_state.resolved_at IS NOT NULL
                           THEN NOW() ELSE collector_silence_alert_state.first_seen_at END,
      announced_at  = CASE WHEN collector_silence_alert_state.resolved_at IS NOT NULL
                           THEN NULL ELSE collector_silence_alert_state.announced_at END,
      broadcast_id  = CASE WHEN collector_silence_alert_state.resolved_at IS NOT NULL
                           THEN NULL ELSE collector_silence_alert_state.broadcast_id END,
      resolved_at   = NULL
`;

/**
 * Claim the right to announce this machine. The WHERE clause is the whole
 * announce-once rule, and it is here rather than in JavaScript because two
 * overlapping sweeps compute identical findings: only the one whose UPDATE
 * actually matched a row may speak, and the second waits on this row's lock and
 * then matches nothing.
 *
 * `broadcast_id` is cleared as part of claiming, so a machine being announced
 * again never points at the expired broadcast from its previous break.
 */
const CLAIM_SQL = `
  UPDATE collector_silence_alert_state
  SET announced_at = NOW(), broadcast_id = NULL
  WHERE user_id = $1 AND machine = $2
    AND resolved_at IS NULL
    AND first_seen_at <= NOW() - INTERVAL '${CONFIRM_HOURS} hours'
    AND (announced_at IS NULL
         OR announced_at < NOW() - INTERVAL '${REANNOUNCE_DAYS} days')
  RETURNING user_id, machine
`;

const RECORD_BROADCAST_SQL = `
  UPDATE collector_silence_alert_state
  SET broadcast_id = $3
  WHERE user_id = $1 AND machine = $2
`;

const RESOLVE_SQL = `
  UPDATE collector_silence_alert_state
  SET resolved_at = NOW()
  WHERE user_id = $1 AND machine = $2
`;

/**
 * End the notice early, but only once it has nothing left to say.
 *
 * One broadcast can cover both of a person's machines. Ending it the moment the
 * first is repaired would retire the only notice the second one will ever get,
 * because its state row stays announced and can no longer be claimed. So the
 * broadcast survives while any *other* machine it was written for is still
 * unresolved.
 *
 * The row being resolved is excluded from that check by $2/$3 rather than by
 * ordering, so this is correct whether it runs before or after RESOLVE_SQL.
 */
const END_BROADCAST_SQL = `
  UPDATE broadcast_messages b
  SET ends_at = NOW()
  WHERE b.id = $1
    AND (b.ends_at IS NULL OR b.ends_at > NOW())
    AND NOT EXISTS (
          SELECT 1 FROM collector_silence_alert_state s
           WHERE s.broadcast_id = $1
             AND s.resolved_at IS NULL
             AND NOT (s.user_id = $2 AND s.machine = $3))
`;

/** A sighting that healed before it was ever confirmed leaves no record. */
const CLEAR_SIGHTING_SQL = `
  DELETE FROM collector_silence_alert_state
  WHERE user_id = $1 AND machine = $2 AND announced_at IS NULL
`;

// Oldest super_admin, matching src/jobs/install-check-alerts.js. Not "any
// super_admin": production has two, and only the first is the person who acts.
const SUPER_ADMIN_SQL = `SELECT id FROM users WHERE role = 'super_admin' ORDER BY id ASC LIMIT 1`;

// 48 hours, un-snoozeable, matching install-check-alerts. severity='warning' with
// allow_snooze=FALSE makes the session-start hook force this into the AI's first
// sentence of every new conversation. Two days of that is a reminder; a week of
// it is something the reader learns to scroll past. Repairing the collector ends
// it sooner than that, via END_BROADCAST_SQL above.
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
 * @returns {Promise<{announced: number, seen: number, resolved: number, broadcast_ids: number[]}>}
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

  const { silences, resolved, cleared } = evaluateSilence({
    rows: beats.rows,
    knownState: stateResult.rows,
    now: now(),
  });

  // Fixed order, here and in the claim loop below. Each statement holds its row
  // lock for the rest of its transaction, so two sweeps taking the same pair of
  // keys in opposite orders would deadlock and Postgres would kill one of them.
  const inKeyOrder = (a, b) => (
    a.user_id - b.user_id || String(a.machine).localeCompare(String(b.machine))
  );
  const ordered = [...silences].sort(inKeyOrder);

  // Record everything first, announce nothing. A machine seen for the first time
  // now cannot satisfy the claim's confirmation window until a later sweep.
  for (const silence of ordered) {
    await query(SIGHTING_SQL, [
      silence.user_id, silence.machine, silence.stale_tools, silence.last_beat_at,
    ]);
  }

  const finish = async (result, log) => {
    // Recoveries are written after the announcing, so a failure here can never
    // stop somebody being told their collector died.
    for (const row of resolved) {
      await withTransaction(async (client) => {
        // Both halves or neither: resolving without ending leaves a repaired
        // machine being announced for two more days with no way to notice, and
        // the state row can never be re-evaluated to fix it.
        if (row.broadcast_id) {
          await client.query(END_BROADCAST_SQL, [row.broadcast_id, row.user_id, row.machine]);
        }
        await client.query(RESOLVE_SQL, [row.user_id, row.machine]);
      });
    }
    for (const row of cleared) {
      await query(CLEAR_SIGHTING_SQL, [row.user_id, row.machine]);
    }

    if (log) {
      if (log.level === 'warn') logger.warn(log.message, log.meta);
      else logger.info(log.message, log.meta);
    }
    return { ...result, seen: silences.length, resolved: resolved.length };
  };

  if (silences.length === 0) {
    return finish({ announced: 0, broadcast_ids: [] }, null);
  }

  // Read the recipient before opening the transaction. If this lookup throws, no
  // claim exists yet and the next sweep starts from a clean state.
  const admin = await query(SUPER_ADMIN_SQL);

  const { result, log } = await withTransaction(async (client) => {
    const claimed = [];

    for (const silence of ordered) {
      const claim = await client.query(CLAIM_SQL, [silence.user_id, silence.machine]);
      if (claim.rowCount > 0) claimed.push(silence);
    }

    if (claimed.length === 0) {
      // The ordinary outcome, not a fault: everything broken today has either
      // been announced already or has not finished its confirmation window.
      return { result: { announced: 0, broadcast_ids: [] }, log: null };
    }

    const broadcastIds = [];
    const adminId = admin.rowCount > 0 ? admin.rows[0].id : null;

    // One message per affected person, addressed to them.
    const byUser = new Map();
    for (const silence of claimed) {
      if (!byUser.has(silence.user_id)) byUser.set(silence.user_id, []);
      byUser.get(silence.user_id).push(silence);
    }

    let omittedForMembers = 0;
    for (const [userId, machines] of byUser) {
      const { title, body, omitted } = renderMemberMessage(machines);
      omittedForMembers += omitted;
      // created_by is the admin where there is one: this is a message the system
      // wrote, and attributing it to the person receiving it reads as though they
      // sent it to themselves.
      const inserted = await client.query(
        BROADCAST_SQL, [title, body, [userId], adminId ?? userId]
      );
      const broadcastId = inserted.rows[0].id;
      broadcastIds.push(broadcastId);
      for (const silence of machines) {
        await client.query(RECORD_BROADCAST_SQL, [userId, silence.machine, broadcastId]);
      }
    }

    // Having no super_admin is not a failure: the members were told, and rolling
    // the claims back would leave every later sweep re-evaluating the same
    // machines forever.
    if (adminId === null) {
      return {
        result: { announced: claimed.length, broadcast_ids: broadcastIds },
        log: {
          level: 'warn',
          message: 'collector-silence: no super_admin, members told but nobody was given the summary',
          meta: { count: claimed.length },
        },
      };
    }

    const summary = renderAdminMessage(claimed);
    const adminBroadcast = await client.query(
      BROADCAST_SQL, [summary.title, summary.body, [adminId], adminId]
    );
    broadcastIds.push(adminBroadcast.rows[0].id);

    return {
      result: { announced: claimed.length, broadcast_ids: broadcastIds },
      log: {
        level: 'info',
        message: 'collector-silence announced',
        meta: {
          count: claimed.length,
          // Both counts, because a message can be cut on either side and a silent
          // truncation reads as "that was everything".
          omitted_admin: summary.omitted,
          omitted_members: omittedForMembers,
          broadcast_ids: broadcastIds,
        },
      },
    };
  });

  // Logging happens after the commit, not inside it: a line written from inside
  // the transaction survives a rollback that undid everything it describes.
  return finish(result, log);
}

/** Daily at 04:00 Asia/Taipei, after the nightly jobs and before the working day. */
export function startCollectorSilenceJob() {
  cron.schedule('0 4 * * *', () => {
    runCollectorSilenceAlerts().catch((err) =>
      logger.error('collector-silence cron failed', { error: err.message }));
  }, { timezone: 'Asia/Taipei' });
}

export default runCollectorSilenceAlerts;
