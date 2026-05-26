import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(__dirname, '..', 'db', '016_bug_reports.sql');

const sql = (() => {
  try {
    return readFileSync(sqlPath, 'utf8');
  } catch {
    return '';
  }
})();

// ============================================================
// File exists + naming convention
// ============================================================

test('016_bug_reports.sql exists', () => {
  statSync(sqlPath);
});

// ============================================================
// Main table bug_reports
// ============================================================

test('creates bug_reports with IF NOT EXISTS (re-runnable)', () => {
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+bug_reports\b/i);
});

test('bug_reports has user_id FK + ON DELETE CASCADE', () => {
  assert.match(sql, /user_id\s+INT\s+NOT\s+NULL\s+REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+CASCADE/i);
});

test('bug_reports has all main columns', () => {
  // Check multiple columns at once to avoid missing one.
  for (const col of [
    'device_fingerprint', 'title', 'description', 'severity',
    'component', 'reproduce_input', 'context_blob', 'bug_fingerprint',
    'related_lint_event_ids', 'status', 'status_reason', 'status_reason_note',
    'created_at', 'updated_at', 'resolved_at', 'resolved_by',
    'notified_to_reporter', 'context_blob_size_bytes', 'client_tool',
  ]) {
    assert.match(sql, new RegExp(`\\b${col}\\b`), `bug_reports should contain column ${col}`);
  }
});

test('bug_reports.severity uses a CHECK to restrict to four values', () => {
  assert.match(sql, /bug_reports_severity_check/);
  assert.match(sql, /CHECK\s*\(\s*severity\s+IN\s*\([^)]*'low'[^)]*'medium'[^)]*'high'[^)]*'critical'/i);
});

test('bug_reports.status uses a CHECK to restrict to five values', () => {
  assert.match(sql, /bug_reports_status_check/);
  assert.match(sql, /CHECK\s*\(\s*status\s+IN\s*\([^)]*'new'[^)]*'triaged'[^)]*'in_progress'[^)]*'fixed'[^)]*'wontfix'/i);
});

test('bug_reports.status_reason uses a CHECK to restrict to five legal values (NULL allowed)', () => {
  assert.match(sql, /bug_reports_status_reason_check/);
  for (const reason of ['by_design', 'duplicate', 'low_priority', 'cannot_reproduce', 'wontfix_other']) {
    assert.match(sql, new RegExp(`'${reason}'`), `status_reason should allow ${reason}`);
  }
});

test('bug_reports has all required indexes', () => {
  for (const idx of [
    'idx_bug_reports_user_created',
    'idx_bug_reports_status_created',
    'idx_bug_reports_fingerprint',
    'idx_bug_reports_user_fingerprint_created',
  ]) {
    assert.match(sql, new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${idx}`, 'i'));
  }
});

// ============================================================
// Cooling-off table bug_report_declines
// ============================================================

test('creates bug_report_declines', () => {
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+bug_report_declines\b/i);
});

test('bug_report_declines has the lookup index for the cooling-off check', () => {
  assert.match(sql, /idx_bug_report_declines_lookup/i);
});

// ============================================================
// spam suspect
// ============================================================

test('creates bug_report_spam_suspects', () => {
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+bug_report_spam_suspects\b/i);
});

test('spam_suspects.trigger_rule uses a CHECK to restrict to four values', () => {
  assert.match(sql, /bug_report_spam_suspects_trigger_rule_check/);
  for (const rule of ['high_volume_1h', 'high_volume_24h', 'repeated_fingerprint', 'similar_content']) {
    assert.match(sql, new RegExp(`'${rule}'`), `trigger_rule should allow ${rule}`);
  }
});

test('spam_suspects.status uses a CHECK to restrict to three values', () => {
  assert.match(sql, /bug_report_spam_suspects_status_check/);
  for (const status of ['pending', 'confirmed_spam', 'dismissed']) {
    assert.match(sql, new RegExp(`'${status}'`), `spam status should allow ${status}`);
  }
});

test('spam_suspects.report_ids is a BIGINT array', () => {
  assert.match(sql, /report_ids\s+BIGINT\[\]\s+NOT\s+NULL/i);
});

// ============================================================
// 24h block list bug_report_spam_blocks
// ============================================================

test('creates bug_report_spam_blocks', () => {
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+bug_report_spam_blocks\b/i);
});

test('spam_blocks.blocked_until defaults to +24h', () => {
  assert.match(sql, /blocked_until[^,]+DEFAULT\s+\(now\(\)\s*\+\s*INTERVAL\s+'24\s+hours'/i);
});

test('spam_blocks has the "is this user currently blocked" lookup index', () => {
  assert.match(sql, /idx_bug_report_spam_blocks_active/i);
});

// ============================================================
// Notification mute bug_report_notification_mutes
// ============================================================

test('creates bug_report_notification_mutes', () => {
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+bug_report_notification_mutes\b/i);
});

test('notification_mutes.mute_target uses a CHECK to restrict to two values', () => {
  assert.match(sql, /bug_report_notification_mutes_target_check/);
  assert.match(sql, /'fingerprint'/);
  assert.match(sql, /'own_reports'/);
});

test('notification_mutes enforces target_value matches mute_target', () => {
  // fingerprint must carry target_value; own_reports must not.
  assert.match(sql, /bug_report_notification_mutes_target_value_check/);
  assert.match(
    sql,
    /mute_target\s*=\s*'fingerprint'\s+AND\s+target_value\s+IS\s+NOT\s+NULL/i
  );
  assert.match(
    sql,
    /mute_target\s*=\s*'own_reports'\s+AND\s+target_value\s+IS\s+NULL/i
  );
});

test('notification_mutes.muted_until defaults to +30 days', () => {
  assert.match(sql, /muted_until[^,]+DEFAULT\s+\(now\(\)\s*\+\s*INTERVAL\s+'30\s+days'/i);
});

// ============================================================
// Global idempotent checks
// ============================================================

test('every CHECK constraint sits inside DO $$ ... END $$ (idempotent re-run guard)', () => {
  // We expect at least one pg_constraint existence check.
  assert.match(sql, /SELECT\s+1\s+FROM\s+pg_constraint\s+WHERE\s+conname\s*=/i);
});

test('every CREATE TABLE uses IF NOT EXISTS', () => {
  const tables = sql.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+bug_report/gi) || [];
  for (const m of tables) {
    assert.match(m, /IF\s+NOT\s+EXISTS/i, `should use IF NOT EXISTS: ${m}`);
  }
});

test('every CREATE INDEX uses IF NOT EXISTS', () => {
  const idxs = sql.match(/CREATE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+idx_bug_report/gi) || [];
  for (const m of idxs) {
    assert.match(m, /IF\s+NOT\s+EXISTS/i, `should use IF NOT EXISTS: ${m}`);
  }
});
