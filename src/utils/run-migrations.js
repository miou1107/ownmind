/**
 * Node-based DB migration runner (v1.19.2)
 *
 * 跑在 src/index.js 啟動時、確保 schema 跟 code 對齊才開始 listen。
 *
 * 為什麼這支存在：
 *   v1.19.0 加了 db/014_iron_rule_tier.sql 但 deploy 時沒人手動 psql -f、prod
 *   memories 表少 tier 欄位、所有 POST /api/memory 回 500。對應 IR-027「邏輯
 *   才有效」+ IR-048「deploy 必須跑 db/ 下未套用 migration」。
 *
 *   把 migration 跑在 server 啟動最前面：
 *   - 每次 docker restart ownmind-api 都自動套未跑的 migration
 *   - 失敗就 throw、process exit 1、container 不會 start listen（避免新 code
 *     配舊 schema）
 *   - 無 deploy 流程改動、Vin 既有「git pull + docker compose build +
 *     docker restart api」工作流不變
 *
 * 跟 scripts/run-migrations.sh 的關係：
 *   - 這支是 server 啟動時自動跑（safety net、必跑）
 *   - shell 版是 CLI 手動跑（dev 環境 / fresh deploy debug 用）
 *   - 兩支跑同一個 schema_migrations 表、結果一致
 *
 * 對應規格：openspec/changes/v1.19.2-auto-migration/spec.md
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

// 只跑 NNN_*.sql（NNN = 3 位數字）；忽略 backfill-iron-rule-codes.sql 等工具 SQL
const MIGRATION_PATTERN = /^\d{3}_.+\.sql$/;

/**
 * 跑所有未套用的 migration、依檔名排序
 *
 * @returns {Promise<{applied: string[], skipped: string[]}>}
 * @throws Error — 任何一條 migration 失敗就 throw、不繼續跑下一條
 */
export async function runMigrations() {
  logger.info('[migrations] DB migration runner starting');

  // 1. 確保 schema_migrations 表存在（chicken-and-egg）
  const bootstrapPath = join(DB_DIR, BOOTSTRAP_SQL);
  try {
    const bootstrapSql = await readFile(bootstrapPath, 'utf8');
    await pool.query(bootstrapSql);
    logger.info('[migrations] schema_migrations table ensured');
  } catch (err) {
    logger.error('[migrations] Bootstrap failed', { error: err.message });
    throw new Error(`Migration bootstrap (015) failed: ${err.message}`);
  }

  // 2. 撈已套用清單
  const { rows: appliedRows } = await pool.query(
    'SELECT filename FROM schema_migrations ORDER BY filename'
  );
  const appliedSet = new Set(appliedRows.map(r => r.filename));
  logger.info('[migrations] Already applied', { count: appliedSet.size });

  // 3. 列 db/ 下符合 NNN_*.sql 的檔、排序
  const allFiles = await readdir(DB_DIR);
  const migrationFiles = allFiles
    .filter(f => MIGRATION_PATTERN.test(f))
    .sort(); // NNN_ 前綴保證 lexical = numerical

  if (migrationFiles.length === 0) {
    logger.warn('[migrations] No migration files found', { dir: DB_DIR });
    return { applied: [], skipped: [] };
  }

  const appliedThisRun = [];
  const skippedThisRun = [];

  // 4. 跑未套用的
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
      // 記錄到追蹤表
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
      // 失敗即停、不繼續跑下一條（避免 schema 半套用）
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
