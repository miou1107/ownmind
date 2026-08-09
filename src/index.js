import 'dotenv/config';
import app from './app.js';
import logger from './utils/logger.js';
import { runMigrations } from './utils/run-migrations.js';
import { startJobs } from './jobs/weeklyReport.js';
import { startNightlyRecomputeJob } from './jobs/nightly-recompute.js';
import { startNightlyUpgradeReminderJob } from './jobs/nightly-upgrade-reminder.js';
import { seedDefaultPasswords } from './jobs/seed-default-passwords.js';
import { runInstallCheckAlerts } from './jobs/install-check-alerts.js';
import {
  runCollectorSilenceAlerts,
  startCollectorSilenceJob,
} from './jobs/collector-silence-alerts.js';

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
    // Evaluate the reports already in the table once per boot, so failures that
    // predate this release surface instead of waiting for each machine to check
    // in again. Idempotent via install_check_alert_state.
    runInstallCheckAlerts().catch((err) =>
      logger.error('install-check startup sweep failed', { error: err.message }));
    // A collector goes quiet because time passed, not because anything was
    // uploaded, so this one does need a schedule. The startup sweep is what
    // makes the machines already silent today surface on the first boot of this
    // release instead of tomorrow morning. Idempotent via
    // collector_silence_alert_state.
    startCollectorSilenceJob();
    runCollectorSilenceAlerts().catch((err) =>
      logger.error('collector-silence startup sweep failed', { error: err.message }));
  });
}

start();
