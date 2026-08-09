import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(__dirname, '..', 'db', '017_bug_reports_id_to_serial.sql');
const sql = (() => {
  try { return readFileSync(sqlPath, 'utf8'); } catch { return ''; }
})();

// ============================================================
// File exists
// ============================================================

test('017_bug_reports_id_to_serial.sql exists', () => {
  statSync(sqlPath);
});

// ============================================================
// Sanity check: refuse to run when any table is non-empty
// ============================================================

test('header contains sanity check: RAISE EXCEPTION if any of the five tables is non-empty', () => {
  assert.match(sql, /RAISE\s+EXCEPTION/i);
  // all five tables must appear in the sanity check
  for (const t of [
    'bug_reports',
    'bug_report_declines',
    'bug_report_spam_suspects',
    'bug_report_spam_blocks',
    'bug_report_notification_mutes',
  ]) {
    assert.match(
      sql,
      new RegExp(`EXISTS\\s*\\(\\s*SELECT\\s+1\\s+FROM\\s+${t}\\s+LIMIT\\s+1\\s*\\)`, 'i'),
      `sanity check should check ${t}`
    );
  }
});

// ============================================================
// DROP order is correct (dependents first, referenced last) + CASCADE
// ============================================================

test('all five tables use DROP TABLE IF EXISTS ... CASCADE', () => {
  for (const t of [
    'bug_report_notification_mutes',
    'bug_report_spam_blocks',
    'bug_report_spam_suspects',
    'bug_report_declines',
    'bug_reports',
  ]) {
    assert.match(
      sql,
      new RegExp(`DROP\\s+TABLE\\s+IF\\s+EXISTS\\s+${t}\\s+CASCADE`, 'i'),
      `expected DROP TABLE IF EXISTS ${t} CASCADE`
    );
  }
});

// ============================================================
// Rebuild: id uses SERIAL, not BIGSERIAL
// ============================================================

test('all five tables use SERIAL (not BIGSERIAL) for id', () => {
  // Scan the id column between CREATE TABLE and the next );
  const tables = [
    'bug_reports',
    'bug_report_declines',
    'bug_report_spam_suspects',
    'bug_report_spam_blocks',
    'bug_report_notification_mutes',
  ];
  for (const t of tables) {
    const re = new RegExp(`CREATE\\s+TABLE\\s+${t}\\s*\\([\\s\\S]*?id\\s+SERIAL\\s+PRIMARY\\s+KEY`, 'i');
    assert.match(sql, re, `${t}.id should be SERIAL PRIMARY KEY`);
  }
});

test('real declarations contain no BIGSERIAL (only allowed inside comments for context)', () => {
  // Strip line comments (-- ...) and block comments; only inspect actual SQL.
  // v1.26.122 — `\r` first. On a CRLF checkout every line ends with a carriage return, and
  // `\r` is a line terminator to a JS regex: `.` will not cross it, so `--.*$` matches
  // nothing and the strip silently does nothing at all. The test then reads its own
  // explanatory comments as SQL and reports a migration that is perfectly correct as broken.
  // A strip that quietly strips nothing is the same failure mode as a redirect to /dev/null.
  const sqlNoComments = sql
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, '')) // strip inline comments
    .join('\n');
  assert.doesNotMatch(
    sqlNoComments,
    /BIGSERIAL/i,
    'real SQL declarations in migration 017 must not use BIGSERIAL (only allowed inside explanatory comments)'
  );
});

// ============================================================
// report_ids switches from BIGINT[] to INT[]
// ============================================================

test('bug_report_spam_suspects.report_ids becomes INT[], not BIGINT[]', () => {
  assert.match(sql, /report_ids\s+INT\[\]\s+NOT\s+NULL/i);
  // Confirm no BIGINT[] left over
  assert.doesNotMatch(sql, /report_ids\s+BIGINT\[\]/i);
});

// ============================================================
// All CHECK constraints are rebuilt
// ============================================================

test('after rebuild, bug_reports has all three CHECK constraints', () => {
  for (const c of [
    'bug_reports_severity_check',
    'bug_reports_status_check',
    'bug_reports_status_reason_check',
  ]) {
    assert.match(sql, new RegExp(`CONSTRAINT\\s+${c}`, 'i'), `should rebuild ${c}`);
  }
});

test('after rebuild, spam_suspects has both CHECK constraints', () => {
  for (const c of [
    'bug_report_spam_suspects_trigger_rule_check',
    'bug_report_spam_suspects_status_check',
  ]) {
    assert.match(sql, new RegExp(`CONSTRAINT\\s+${c}`, 'i'), `should rebuild ${c}`);
  }
});

test('after rebuild, notification_mutes has both CHECK constraints', () => {
  for (const c of [
    'bug_report_notification_mutes_target_check',
    'bug_report_notification_mutes_target_value_check',
  ]) {
    assert.match(sql, new RegExp(`CONSTRAINT\\s+${c}`, 'i'), `should rebuild ${c}`);
  }
});

// ============================================================
// All indexes are rebuilt
// ============================================================

test('all six indexes are rebuilt', () => {
  for (const idx of [
    'idx_bug_reports_user_created',
    'idx_bug_reports_status_created',
    'idx_bug_reports_fingerprint',
    'idx_bug_reports_user_fingerprint_created',
    'idx_bug_report_declines_lookup',
    'idx_bug_report_spam_suspects_status_triggered',
    'idx_bug_report_spam_blocks_active',
    'idx_bug_report_notification_mutes_lookup',
  ]) {
    assert.match(
      sql,
      new RegExp(`CREATE\\s+INDEX\\s+${idx}\\b`, 'i'),
      `should rebuild index ${idx}`
    );
  }
});

// ============================================================
// Defaults match the originals (blocked_until +24h, muted_until +30 days)
// ============================================================

test('blocked_until default is still +24 hours', () => {
  assert.match(sql, /blocked_until[^,]+DEFAULT\s+\(now\(\)\s*\+\s*INTERVAL\s+'24\s+hours'/i);
});

test('muted_until default is still +30 days', () => {
  assert.match(sql, /muted_until[^,]+DEFAULT\s+\(now\(\)\s*\+\s*INTERVAL\s+'30\s+days'/i);
});
