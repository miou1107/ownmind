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
  // v1.19.2: automatically apply unrun DB migrations before the server starts, to
  // ensure the schema is aligned with the code. On failure, process.exit(1) so the
  // container never starts listening (avoiding new code serving against an old schema,
  // like the v1.19.0 → v1.19.1 incident).
  try {
    await runMigrations();
  } catch (err) {
    logger.error('Server startup aborted — migrations failed', { error: err.message });
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info(`OwnMind API server started, listening on port ${PORT}`);
    startJobs();
    startNightlyRecomputeJob();
    startNightlyUpgradeReminderJob();
    // v1.17.25: seed a default password for users without a password_hash (idempotent)
    seedDefaultPasswords();
  });
}

start();
