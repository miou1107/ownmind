import 'dotenv/config';
import app from './app.js';
import logger from './utils/logger.js';
import { startJobs } from './jobs/weeklyReport.js';
import { startNightlyRecomputeJob } from './jobs/nightly-recompute.js';
import { startNightlyUpgradeReminderJob } from './jobs/nightly-upgrade-reminder.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`OwnMind API 伺服器已啟動，監聽埠號 ${PORT}`);
  startJobs();
  startNightlyRecomputeJob();
  startNightlyUpgradeReminderJob();
});
