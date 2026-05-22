import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const shPath = join(__dirname, '..', 'scripts', 'run-migrations.sh');
const sqlPath = join(__dirname, '..', 'db', '015_schema_migrations_table.sql');
const jsRunnerPath = join(__dirname, '..', 'src', 'utils', 'run-migrations.js');
const serverEntryPath = join(__dirname, '..', 'src', 'index.js');

// ============================================================
// 015_schema_migrations_table.sql
// ============================================================

test('015_schema_migrations_table.sql exists', () => {
  statSync(sqlPath);
});

test('015 SQL creates schema_migrations table with IF NOT EXISTS', () => {
  const src = readFileSync(sqlPath, 'utf8');
  assert.match(src, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+schema_migrations/i,
    'must use IF NOT EXISTS to be idempotent');
});

test('015 SQL declares filename as PRIMARY KEY', () => {
  const src = readFileSync(sqlPath, 'utf8');
  assert.match(src, /filename\s+VARCHAR\(\d+\)\s+PRIMARY\s+KEY/i,
    'filename should be PK to prevent duplicate registrations');
});

test('015 SQL self-records its own filename with ON CONFLICT DO NOTHING', () => {
  const src = readFileSync(sqlPath, 'utf8');
  assert.match(src, /INSERT\s+INTO\s+schema_migrations[^;]+015_schema_migrations_table\.sql/i,
    'must self-record so subsequent runner runs see it as applied');
  assert.match(src, /ON\s+CONFLICT[^;]*DO\s+NOTHING/i,
    'must use ON CONFLICT DO NOTHING for idempotent re-runs');
});

test('015 SQL has applied_at column with NOW() default', () => {
  const src = readFileSync(sqlPath, 'utf8');
  assert.match(src, /applied_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/i);
});

// ============================================================
// scripts/run-migrations.sh — structural assertions
// ============================================================

test('run-migrations.sh exists and is executable', () => {
  const stat = statSync(shPath);
  assert.ok(stat.mode & 0o100, 'run-migrations.sh must have user-execute bit (chmod +x)');
});

test('run-migrations.sh uses INFO/OK/ERROR logging convention', () => {
  const src = readFileSync(shPath, 'utf8');
  assert.match(src, /INFO:[a-z_]+:/, 'expected INFO:<code>: log lines');
  assert.match(src, /OK:[a-z_]+:/,   'expected OK:<code>: log lines');
  assert.match(src, /ERROR:[a-z_]+:/, 'expected ERROR:<code>: log lines');
});

test('run-migrations.sh ensures schema_migrations table exists first (bootstrap step)', () => {
  const src = readFileSync(shPath, 'utf8');
  assert.match(src, /015_schema_migrations_table\.sql/,
    'must apply 015 first to break chicken-and-egg before main loop');
});

test('run-migrations.sh only scans NNN_ prefixed SQL files (skips non-migration scripts)', () => {
  const src = readFileSync(shPath, 'utf8');
  // glob pattern using digit pattern, not just *.sql
  assert.match(src, /\[0-9\]\[0-9\]\[0-9\]_/,
    'must restrict to [0-9][0-9][0-9]_ glob so backfill-iron-rule-codes.sql etc. are skipped');
});

test('run-migrations.sh queries schema_migrations to detect applied state', () => {
  const src = readFileSync(shPath, 'utf8');
  assert.match(src, /SELECT[^;]*filename[^;]*FROM[^;]*schema_migrations/i,
    'must query applied filenames before deciding to run');
});

test('run-migrations.sh inserts into schema_migrations after each successful apply', () => {
  const src = readFileSync(shPath, 'utf8');
  assert.match(src, /INSERT\s+INTO\s+schema_migrations/i,
    'must record each successful migration to make subsequent runs idempotent');
});

test('run-migrations.sh fails fast (set -e or explicit exit 1)', () => {
  const src = readFileSync(shPath, 'utf8');
  const hasSetE = /set\s+-e/.test(src);
  const hasExitOne = /exit\s+1/.test(src);
  assert.ok(hasSetE || hasExitOne,
    'must fail fast on migration error (set -e or explicit exit 1)');
});

test('run-migrations.sh sorts files before processing (deterministic order)', () => {
  const src = readFileSync(shPath, 'utf8');
  assert.match(src, /\bsort\b/,
    'must sort migration files for deterministic order (NNN_ prefix ensures lexical = numeric)');
});

test('run-migrations.sh has docker-exec fallback to direct psql', () => {
  const src = readFileSync(shPath, 'utf8');
  // either branches on docker availability or supports both modes
  const hasDocker = /docker\s+exec[^|]*ownmind-db/.test(src);
  const hasPsqlDirect = /\bpsql\b/.test(src);
  assert.ok(hasDocker && hasPsqlDirect,
    'must support both docker exec and direct psql (env-detected)');
});

// ============================================================
// src/utils/run-migrations.js — Node-based migrator (server startup)
// ============================================================

test('src/utils/run-migrations.js exists', () => {
  statSync(jsRunnerPath);
});

test('Node migrator exports an async runMigrations function', () => {
  const src = readFileSync(jsRunnerPath, 'utf8');
  assert.match(src, /export\s+(async\s+)?function\s+runMigrations|export\s*\{\s*runMigrations/,
    'must export named runMigrations for src/index.js to call');
});

test('Node migrator ensures schema_migrations table before main loop', () => {
  const src = readFileSync(jsRunnerPath, 'utf8');
  assert.match(src, /015_schema_migrations_table\.sql/,
    'must apply 015 bootstrap first (chicken-and-egg)');
});

test('Node migrator scans only NNN_*.sql files', () => {
  const src = readFileSync(jsRunnerPath, 'utf8');
  // regex pattern or glob restricting to NNN_ prefix
  assert.match(src, /\^?\[0-9\]\[0-9\]\[0-9\]_|\^?\\d\{3\}_|\^\\d\\d\\d_|\/\^\\d\{3\}_/,
    'must restrict to NNN_*.sql to skip non-migration scripts like backfill-iron-rule-codes.sql');
});

test('Node migrator queries schema_migrations + inserts after each apply', () => {
  const src = readFileSync(jsRunnerPath, 'utf8');
  assert.match(src, /SELECT[^;]*filename[^;]*FROM\s+schema_migrations/i);
  assert.match(src, /INSERT\s+INTO\s+schema_migrations/i);
});

test('Node migrator throws on migration failure (fail fast)', () => {
  const src = readFileSync(jsRunnerPath, 'utf8');
  // either throw or rethrow in catch
  assert.match(src, /throw\s+/,
    'must throw on migration failure so caller can abort startup');
});

// ============================================================
// src/index.js — startup integration
// ============================================================

test('src/index.js imports runMigrations', () => {
  const src = readFileSync(serverEntryPath, 'utf8');
  assert.match(src, /import\s+\{[^}]*runMigrations[^}]*\}\s+from\s+['"][^'"]*run-migrations[^'"]*['"]/,
    'src/index.js must import runMigrations from utils/run-migrations.js');
});

test('src/index.js calls runMigrations() before app.listen', () => {
  const src = readFileSync(serverEntryPath, 'utf8');
  const callIdx = src.search(/await\s+runMigrations\s*\(/);
  const listenIdx = src.search(/app\.listen\s*\(/);
  assert.ok(callIdx >= 0, 'must await runMigrations() before listening');
  assert.ok(listenIdx >= 0, 'must call app.listen()');
  assert.ok(callIdx < listenIdx, 'runMigrations() must be called BEFORE app.listen() so api never starts with stale schema');
});
