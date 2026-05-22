import 'dotenv/config';
import app from './app.js';
import logger from './utils/logger.js';
import { runMigrations } from './utils/run-migrations.js';
import { startJobs } from './jobs/weeklyReport.js';
import { startNightlyRecomputeJob } from './jobs/nightly-recompute.js';
import { startNightlyUpgradeReminderJob } from './jobs/nightly-upgrade-reminder.js';
import { seedDefaultPasswords } from './jobs/seed-default-passwords.js';

const PORT = process.env.PORT || 3000;

async function start() {
  // v1.19.2 IR-048：server 啟動前自動套未跑的 DB migration、確保 schema 跟
  // code 對齊。失敗就 process.exit(1)、container 不會開始 listen（避免新
  // code 配舊 schema 對外服務、像 v1.19.0 → v1.19.1 那次踩坑）。
  try {
    await runMigrations();
  } catch (err) {
    logger.error('Server startup aborted — migrations failed', { error: err.message });
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info(`OwnMind API 伺服器已啟動，監聽埠號 ${PORT}`);
    startJobs();
    startNightlyRecomputeJob();
    startNightlyUpgradeReminderJob();
    // v1.17.25: 補預設密碼給沒 password_hash 的 user（idempotent）
    seedDefaultPasswords();
  });
}

start();
