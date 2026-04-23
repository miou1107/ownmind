/**
 * nightly-upgrade-reminder.js — 每日 03:30 Asia/Taipei 產生升級提醒廣播
 *
 * 行為：
 *   1. 讀當前 SERVER_VERSION（package.json）
 *   2. 查是否已有 (type='upgrade_reminder', is_auto=TRUE, max_version=<SERVER_VERSION - 0.0.1>)
 *      — UNIQUE index ux_broadcast_auto_upgrade 保證冪等
 *   3. 沒有就 insert 一筆新的 upgrade_reminder
 *
 * 為什麼排 03:30：避開 03:00 nightly-recompute 的 DB 壓力
 *
 * Max version 策略：
 *   實際存 SERVER_VERSION 的「上一個 patch」— 例如 SERVER_VERSION='1.17.0' → max_version='1.17.0-prev'
 *   這會讓 isHigher(client_version, max_version) 對 1.17.0 stable 傳 TRUE → filter 掉
 *   對 1.16.x / 1.17.0-beta / 1.17.0-dev 傳 FALSE → 通過顯示
 *   （semver.js 的 pre-release rule 讓這個比對自然運作）
 *
 *   簡單做法：max_version = `${SERVER_VERSION}-prev`
 *   stable SERVER_VERSION（如 1.17.0）不會帶 -xxx，所以 `1.17.0-prev` < `1.17.0`
 *   已升到 1.17.0 的 user：isHigher('1.17.0', '1.17.0-prev') === true → 被 filter 掉 ✓
 *   1.16.x 的 user：isHigher('1.16.5', '1.17.0-prev') === false → 通過 ✓
 */

import cron from 'node-cron';
import { createRequire } from 'module';
import { query as defaultQuery } from '../utils/db.js';
import logger from '../utils/logger.js';

const SERVER_VERSION = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require('../../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export async function ensureUpgradeReminder({ query = defaultQuery, serverVersion = SERVER_VERSION, systemUserId } = {}) {
  // 以 `-prev` 當「比當前小的任何版本」門檻（利用 pre-release semver 排序規則）
  const maxVersion = `${serverVersion}-prev`;

  // 1. 挑一個 super_admin 當 created_by（升級提醒是系統發的，找最老的 super_admin 掛名）
  let uid = systemUserId;
  if (!uid) {
    const r = await query(
      `SELECT id FROM users WHERE role = 'super_admin' ORDER BY id ASC LIMIT 1`
    );
    if (r.rowCount === 0) {
      logger.warn('nightly-upgrade-reminder 略過：系統尚無 super_admin');
      return { inserted: false, reason: 'no_super_admin' };
    }
    uid = r.rows[0].id;
  }

  // 2. 嘗試 insert；同 (type, max_version) 已存在會被 UNIQUE index 擋下
  const title = `OwnMind 有新版本 ${serverVersion}`;
  const body =
    `你目前使用的版本落後，請說「我要升級」讓 AI 幫你自動完成。\n\n` +
    `新版包含：v1.17.0 起的廣播通知 + 互動升級流程。` +
    `若暫時不想升級，可說「暫緩升級」延後 24 小時再提醒。`;

  // 3. 先查有沒有 active（ends_at IS NULL 或未來）的相同 reminder；已撤銷的視為不存在 → 允許重建
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

  // 4. INSERT — 靠 partial unique index + SQLSTATE 23505（unique_violation）處理並發 race
  //    不靠錯誤字串匹配（不同 pg 版本 / locale 訊息可能不同）
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
    logger.info('nightly-upgrade-reminder 已建立', {
      broadcast_id: result.rows[0].id,
      server_version: serverVersion,
      max_version: maxVersion
    });
    return { inserted: true, broadcast_id: result.rows[0].id, max_version: maxVersion };
  } catch (err) {
    // PG SQLSTATE 23505 = unique_violation；另看 err.constraint（node-pg 會附）雙重確認
    if (err.code === '23505' || err.constraint === 'ux_broadcast_auto_upgrade') {
      return { inserted: false, reason: 'already_exists_race', max_version: maxVersion };
    }
    logger.error('nightly-upgrade-reminder insert 失敗', { error: err.message });
    return { inserted: false, error: err.message };
  }
}

export function startNightlyUpgradeReminderJob() {
  cron.schedule('30 3 * * *', () => {
    ensureUpgradeReminder().catch((err) =>
      logger.error('nightly-upgrade-reminder cron 失敗', { error: err.message }));
  }, { timezone: 'Asia/Taipei' });

  logger.info('nightly upgrade reminder job 已啟動（每日 03:30 Asia/Taipei）');
}
