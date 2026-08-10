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

/**
 * How far behind a client has to fall before this reminder is worth showing.
 *
 * v1.26.129: the threshold used to be `${SERVER_VERSION}-prev`, i.e. anyone not on the exact
 * newest build. This repo ships several versions a day, so that fired for nearly everyone,
 * nearly every day — and the reminder is a mandatory-severity broadcast, which takes over the
 * AI's first sentence. The update is automatic now; a daily "please upgrade" is telling the
 * user to do something that already happened.
 *
 * What is left worth saying is the case the automation cannot cover: a machine whose updates
 * are not landing at all. Ten patches is a few days of that.
 */
export const LAG_PATCHES = 10;

/** The version a client must be at or above to be spared the reminder. */
export function reminderThreshold(serverVersion) {
  const [major, minor, patch] = String(serverVersion).split('.').map((n) => parseInt(n, 10) || 0);
  // Below the lag within this minor, fall back to its .0: an early patch of a new minor means
  // anyone still on the previous minor is the one who is stuck.
  const target = patch > LAG_PATCHES ? patch - LAG_PATCHES : 0;
  return `${major}.${minor}.${target}-prev`;
}

export async function ensureUpgradeReminder({ query = defaultQuery, serverVersion = SERVER_VERSION, systemUserId } = {}) {
  // `-prev` sorts below the release itself (semver pre-release ordering), so a client exactly
  // at the threshold is spared and anything below it is reminded.
  const maxVersion = reminderThreshold(serverVersion);

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
  // v1.26.129: this is no longer "there is a new version" — the update runs by itself every
  // day. Reaching this broadcast means it has not landed for days, so the message says that
  // instead, and asks for the one thing automation cannot do for them.
  const title = `OwnMind 的自動更新好像沒在運作`;
  const body =
    `你的版本已經落後 ${LAG_PATCHES} 個版本以上。OwnMind 每天會自己在背景更新，` +
    `所以這通常表示更新失敗了。\n\n` +
    `說「我要升級」讓 AI 幫你手動跑一次；` +
    `若還是失敗，說「回報 ownmind bug」把狀況送給管理者。` +
    `暫時不想處理可說「暫緩升級」，24 小時後再提醒。`;

  // v1.26.129 — retire the auto reminders this one supersedes.
  //
  // These rows have never carried an `ends_at`, and the admin API refuses to revoke `is_auto`
  // broadcasts, so every reminder the nightly job has created since v1.17.0 is still live.
  // Changing the threshold above would therefore change nothing for the people it is meant to
  // spare: a user five versions behind still matches yesterday's row, and its wording is the
  // old "有新版本" announcement. Worse, the fetch sorts newest-first and the hook shows three,
  // so a genuinely stuck user would get the new message with two stale ones stacked under it.
  //
  // Scoped to `is_auto = TRUE` + `type = 'upgrade_reminder'`: nothing a human wrote is touched.
  await query(
    `UPDATE broadcast_messages
        SET ends_at = NOW()
      WHERE is_auto = TRUE
        AND type = 'upgrade_reminder'
        AND max_version IS DISTINCT FROM $1
        AND (ends_at IS NULL OR ends_at > NOW())`,
    [maxVersion]
  );

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
