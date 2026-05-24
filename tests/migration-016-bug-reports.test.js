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
// 檔案存在 + 命名慣例
// ============================================================

test('016_bug_reports.sql 存在', () => {
  statSync(sqlPath);
});

// ============================================================
// 主表 bug_reports
// ============================================================

test('建立 bug_reports 表、用 IF NOT EXISTS 可重跑', () => {
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+bug_reports\b/i);
});

test('bug_reports 必有 user_id FK + ON DELETE CASCADE', () => {
  assert.match(sql, /user_id\s+INT\s+NOT\s+NULL\s+REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+CASCADE/i);
});

test('bug_reports 主要欄位齊全', () => {
  // 一次檢查多個欄位、避免遺漏
  for (const col of [
    'device_fingerprint', 'title', 'description', 'severity',
    'component', 'reproduce_input', 'context_blob', 'bug_fingerprint',
    'related_lint_event_ids', 'status', 'status_reason', 'status_reason_note',
    'created_at', 'updated_at', 'resolved_at', 'resolved_by',
    'notified_to_reporter', 'context_blob_size_bytes', 'client_tool',
  ]) {
    assert.match(sql, new RegExp(`\\b${col}\\b`), `bug_reports 應含欄位 ${col}`);
  }
});

test('bug_reports.severity 用 CHECK 限制四個值', () => {
  assert.match(sql, /bug_reports_severity_check/);
  assert.match(sql, /CHECK\s*\(\s*severity\s+IN\s*\([^)]*'low'[^)]*'medium'[^)]*'high'[^)]*'critical'/i);
});

test('bug_reports.status 用 CHECK 限制五個值', () => {
  assert.match(sql, /bug_reports_status_check/);
  assert.match(sql, /CHECK\s*\(\s*status\s+IN\s*\([^)]*'new'[^)]*'triaged'[^)]*'in_progress'[^)]*'fixed'[^)]*'wontfix'/i);
});

test('bug_reports.status_reason 用 CHECK 限制五個合法值（可為 NULL）', () => {
  assert.match(sql, /bug_reports_status_reason_check/);
  for (const reason of ['by_design', 'duplicate', 'low_priority', 'cannot_reproduce', 'wontfix_other']) {
    assert.match(sql, new RegExp(`'${reason}'`), `status_reason 應允許 ${reason}`);
  }
});

test('bug_reports 索引齊全', () => {
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
// 冷靜期 bug_report_declines
// ============================================================

test('建立 bug_report_declines 表', () => {
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+bug_report_declines\b/i);
});

test('bug_report_declines 有給冷靜期查詢用的 index', () => {
  assert.match(sql, /idx_bug_report_declines_lookup/i);
});

// ============================================================
// spam suspect
// ============================================================

test('建立 bug_report_spam_suspects 表', () => {
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+bug_report_spam_suspects\b/i);
});

test('spam_suspects.trigger_rule 用 CHECK 限制四種', () => {
  assert.match(sql, /bug_report_spam_suspects_trigger_rule_check/);
  for (const rule of ['high_volume_1h', 'high_volume_24h', 'repeated_fingerprint', 'similar_content']) {
    assert.match(sql, new RegExp(`'${rule}'`), `trigger_rule 應允許 ${rule}`);
  }
});

test('spam_suspects.status 用 CHECK 限制三種', () => {
  assert.match(sql, /bug_report_spam_suspects_status_check/);
  for (const status of ['pending', 'confirmed_spam', 'dismissed']) {
    assert.match(sql, new RegExp(`'${status}'`), `spam status 應允許 ${status}`);
  }
});

test('spam_suspects.report_ids 是 BIGINT 陣列', () => {
  assert.match(sql, /report_ids\s+BIGINT\[\]\s+NOT\s+NULL/i);
});

// ============================================================
// 24h 封鎖 bug_report_spam_blocks
// ============================================================

test('建立 bug_report_spam_blocks 表', () => {
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+bug_report_spam_blocks\b/i);
});

test('spam_blocks.blocked_until 預設 +24h', () => {
  assert.match(sql, /blocked_until[^,]+DEFAULT\s+\(now\(\)\s*\+\s*INTERVAL\s+'24\s+hours'/i);
});

test('spam_blocks 有給「該 user 是否在封鎖期」查詢的 index', () => {
  assert.match(sql, /idx_bug_report_spam_blocks_active/i);
});

// ============================================================
// 通知靜音 bug_report_notification_mutes
// ============================================================

test('建立 bug_report_notification_mutes 表', () => {
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+bug_report_notification_mutes\b/i);
});

test('notification_mutes.mute_target 用 CHECK 限制兩種', () => {
  assert.match(sql, /bug_report_notification_mutes_target_check/);
  assert.match(sql, /'fingerprint'/);
  assert.match(sql, /'own_reports'/);
});

test('notification_mutes 強制 target_value 跟 mute_target 對應正確', () => {
  // fingerprint 必須帶 target_value、own_reports 必須不帶
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

test('notification_mutes.muted_until 預設 +30 天', () => {
  assert.match(sql, /muted_until[^,]+DEFAULT\s+\(now\(\)\s*\+\s*INTERVAL\s+'30\s+days'/i);
});

// ============================================================
// 全域 idempotent 檢查
// ============================================================

test('所有 CHECK constraint 都包在 DO $$ ... END $$ 裡（idempotent 重跑保險）', () => {
  // 至少看到一個 pg_constraint 存在性檢查
  assert.match(sql, /SELECT\s+1\s+FROM\s+pg_constraint\s+WHERE\s+conname\s*=/i);
});

test('所有 CREATE TABLE 都用 IF NOT EXISTS', () => {
  const tables = sql.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+bug_report/gi) || [];
  for (const m of tables) {
    assert.match(m, /IF\s+NOT\s+EXISTS/i, `應該用 IF NOT EXISTS：${m}`);
  }
});

test('所有 CREATE INDEX 都用 IF NOT EXISTS', () => {
  const idxs = sql.match(/CREATE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+idx_bug_report/gi) || [];
  for (const m of idxs) {
    assert.match(m, /IF\s+NOT\s+EXISTS/i, `應該用 IF NOT EXISTS：${m}`);
  }
});
