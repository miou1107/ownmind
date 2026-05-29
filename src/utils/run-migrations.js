/**
 * Node-based DB migration runner (v1.19.2)
 *
 * Runs at src/index.js startup, ensuring the schema is aligned with the code
 * before it starts listening.
 *
 * Why this exists:
 *   v1.19.0 added db/014_iron_rule_tier.sql, but on deploy nobody ran psql -f
 *   manually, so the prod memories table was missing the tier column and every
 *   POST /api/memory returned 500. This addresses the "logic, not reminders"
 *   principle and the "deploy must run unapplied migrations under db/" rule.
 *
 *   Running migrations at the very start of server boot means:
 *   - every docker restart of ownmind-api automatically applies unrun migrations
 *   - a failure throws, process exits 1, and the container never starts listening
 *     (avoiding new code paired with an old schema)
 *   - no deploy-flow changes; Vin's existing "git pull + docker compose build +
 *     docker restart api" workflow stays the same
 *
 * Relationship to scripts/run-migrations.sh:
 *   - this one runs automatically at server startup (safety net, always runs)
 *   - the shell version is run manually via CLI (for dev env / fresh-deploy debugging)
 *   - both use the same schema_migrations table and produce consistent results
 *
 * Spec: openspec/changes/v1.19.2-auto-migration/spec.md
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from './db.js';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/utils/ → ../../db/
const DB_DIR = resolve(__dirname, '..', '..', 'db');
const BOOTSTRAP_SQL = '015_schema_migrations_table.sql';

// only run NNN_*.sql (NNN = 3 digits); ignore tooling SQL like backfill-iron-rule-codes.sql
const MIGRATION_PATTERN = /^\d{3}_.+\.sql$/;

/**
 * Run all unapplied migrations, ordered by filename.
 *
 * @returns {Promise<{applied: string[], skipped: string[]}>}
 * @throws Error — if any migration fails, throw and do not run the next one
 */
export async function runMigrations() {
  logger.info('[migrations] DB migration runner starting');

  // 1. ensure the schema_migrations table exists (chicken-and-egg)
  const bootstrapPath = join(DB_DIR, BOOTSTRAP_SQL);
  try {
    const bootstrapSql = await readFile(bootstrapPath, 'utf8');
    await pool.query(bootstrapSql);
    logger.info('[migrations] schema_migrations table ensured');
  } catch (err) {
    logger.error('[migrations] Bootstrap failed', { error: err.message });
    throw new Error(`Migration bootstrap (015) failed: ${err.message}`);
  }

  // 2. fetch the applied list
  const { rows: appliedRows } = await pool.query(
    'SELECT filename FROM schema_migrations ORDER BY filename'
  );
  const appliedSet = new Set(appliedRows.map(r => r.filename));
  logger.info('[migrations] Already applied', { count: appliedSet.size });

  // 3. list files under db/ matching NNN_*.sql, sorted
  const allFiles = await readdir(DB_DIR);
  const migrationFiles = allFiles
    .filter(f => MIGRATION_PATTERN.test(f))
    .sort(); // the NNN_ prefix guarantees lexical = numerical

  if (migrationFiles.length === 0) {
    logger.warn('[migrations] No migration files found', { dir: DB_DIR });
    return { applied: [], skipped: [] };
  }

  const appliedThisRun = [];
  const skippedThisRun = [];

  // 4. run the unapplied ones
  for (const filename of migrationFiles) {
    if (appliedSet.has(filename)) {
      skippedThisRun.push(filename);
      continue;
    }
    logger.info('[migrations] Applying', { filename });
    const sqlPath = join(DB_DIR, filename);
    try {
      const sql = await readFile(sqlPath, 'utf8');
      await pool.query(sql);
      // record into the tracking table
      await pool.query(
        `INSERT INTO schema_migrations (filename, applied_by)
         VALUES ($1, $2)
         ON CONFLICT (filename) DO NOTHING`,
        [filename, 'server_startup']
      );
      appliedThisRun.push(filename);
      logger.info('[migrations] Applied successfully', { filename });
    } catch (err) {
      logger.error('[migrations] Migration failed — stopping', {
        filename,
        error: err.message,
      });
      // stop on failure, don't run the next one (avoids a half-applied schema)
      throw new Error(`Migration ${filename} failed: ${err.message}`);
    }
  }

  if (appliedThisRun.length === 0) {
    logger.info('[migrations] ✅ DB schema is up to date', {
      skipped: skippedThisRun.length,
    });
  } else {
    logger.info('[migrations] ✅ Migrations applied', {
      applied: appliedThisRun,
      skippedCount: skippedThisRun.length,
    });
  }

  return { applied: appliedThisRun, skipped: skippedThisRun };
}

export default runMigrations;
