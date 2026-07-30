/**
 * nightly-upgrade-reminder.js — generate the upgrade-reminder broadcast daily at 03:30 Asia/Taipei
 *
 * Behavior:
 *   1. read the current SERVER_VERSION (package.json)
 *   2. check whether (type='upgrade_reminder', is_auto=TRUE, max_version=<SERVER_VERSION - 0.0.1>) already exists
 *      — the UNIQUE index ux_broadcast_auto_upgrade guarantees idempotency
 *   3. if not, insert a new upgrade_reminder
 *
 * Why schedule at 03:30: avoid the DB pressure of the 03:00 nightly-recompute
 *
 * Max version strategy:
 *   Actually stores the "patch just before" SERVER_VERSION — e.g. SERVER_VERSION='1.17.0' → max_version='1.17.0-prev'
 *   This makes isHigher(client_version, max_version) return TRUE for 1.17.0 stable → filtered out
 *   and FALSE for 1.16.x / 1.17.0-beta / 1.17.0-dev → passes through and is shown
 *   (semver.js's pre-release rule makes this comparison work naturally)
 *
 *   Simple approach: max_version = `${SERVER_VERSION}-prev`
 *   A stable SERVER_VERSION (e.g. 1.17.0) carries no -xxx, so `1.17.0-prev` < `1.17.0`
 *   A user already on 1.17.0: isHigher('1.17.0', '1.17.0-prev') === true → filtered out ✓
 *   A user on 1.16.x: isHigher('1.16.5', '1.17.0-prev') === false → passes ✓
 */

import cron from 'node-cron';
import { query as defaultQuery } from '../utils/db.js';
import logger from '../utils/logger.js';
import { SERVER_VERSION } from '../utils/server-version.js';

export async function ensureUpgradeReminder({ query = defaultQuery, serverVersion = SERVER_VERSION, systemUserId } = {}) {
  // use `-prev` as the "any version lower than current" threshold (leveraging pre-release semver ordering)
  const maxVersion = `${serverVersion}-prev`;

  // 1. pick a super_admin as created_by (the upgrade reminder is system-issued; attribute it to the oldest super_admin)
  let uid = systemUserId;
  if (!uid) {
    const r = await query(
      `SELECT id FROM users WHERE role = 'super_admin' ORDER BY id ASC LIMIT 1`
    );
    if (r.rowCount === 0) {
      logger.warn('nightly-upgrade-reminder skipped: the system has no super_admin yet');
      return { inserted: false, reason: 'no_super_admin' };
    }
    uid = r.rows[0].id;
  }

  // 2. try to insert; an existing (type, max_version) is blocked by the UNIQUE index
  const title = `OwnMind 有新版本 ${serverVersion}`;
  const body =
    `你目前使用的版本落後，請說「我要升級」讓 AI 幫你自動完成。\n\n` +
    `新版包含：v1.17.0 起的廣播通知 + 互動升級流程。` +
    `若暫時不想升級，可說「暫緩升級」延後 24 小時再提醒。`;

  // 3. first check for an active (ends_at IS NULL or future) identical reminder; a revoked one counts as nonexistent → allow recreation
  const existing = await query(
    `SELECT id FROM broadcast_messages
     WHERE is_auto = TRUE
       AND type = 'upgrade_reminder'
       AND max_version = $1
       AND (ends_at IS NULL OR ends_at > NOW())
     LIMIT 1`,
    [maxVersion]
  );
  if (existing.rowCount > 0) {
    return { inserted: false, reason: 'already_exists', max_version: maxVersion, broadcast_id: existing.rows[0].id };
  }

  // 4. INSERT — rely on the partial unique index + SQLSTATE 23505 (unique_violation) to handle the concurrent race
  //    do not rely on error-string matching (messages differ across pg versions / locales)
  try {
    const result = await query(
      `INSERT INTO broadcast_messages
       (type, severity, title, body, cta_text, cta_action,
        max_version, allow_snooze, snooze_hours, cooldown_minutes,
        is_auto, created_by)
       VALUES ('upgrade_reminder', 'warning', $1, $2, '我要升級', 'upgrade_ownmind',
               $3, TRUE, 24, 30, TRUE, $4)
       RETURNING id`,
      [title, body, maxVersion, uid]
    );
    logger.info('nightly-upgrade-reminder created', {
      broadcast_id: result.rows[0].id,
      server_version: serverVersion,
      max_version: maxVersion
    });
    return { inserted: true, broadcast_id: result.rows[0].id, max_version: maxVersion };
  } catch (err) {
    // PG SQLSTATE 23505 = unique_violation; also check err.constraint (node-pg attaches it) for double confirmation
    if (err.code === '23505' || err.constraint === 'ux_broadcast_auto_upgrade') {
      return { inserted: false, reason: 'already_exists_race', max_version: maxVersion };
    }
    logger.error('nightly-upgrade-reminder insert failed', { error: err.message });
    return { inserted: false, error: err.message };
  }
}

export function startNightlyUpgradeReminderJob() {
  cron.schedule('30 3 * * *', () => {
    ensureUpgradeReminder().catch((err) =>
      logger.error('nightly-upgrade-reminder cron failed', { error: err.message }));
  }, { timezone: 'Asia/Taipei' });

  logger.info('nightly upgrade reminder job started (daily 03:30 Asia/Taipei)');
}
