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
// 檔案存在
// ============================================================

test('017_bug_reports_id_to_serial.sql 存在', () => {
  statSync(sqlPath);
});

// ============================================================
// Sanity check：表非空時拒絕跑
// ============================================================

test('開頭含 sanity check：五張表任一非空就 RAISE EXCEPTION', () => {
  assert.match(sql, /RAISE\s+EXCEPTION/i);
  // 五張表都要在 sanity check 裡
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
      `sanity check 應檢查 ${t}`
    );
  }
});

// ============================================================
// DROP 順序正確（先 dependent、再被 reference 的）+ CASCADE
// ============================================================

test('五張表都用 DROP TABLE IF EXISTS ... CASCADE', () => {
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
      `應該 DROP TABLE IF EXISTS ${t} CASCADE`
    );
  }
});

// ============================================================
// 重建：id 用 SERIAL、不是 BIGSERIAL
// ============================================================

test('五張表都用 SERIAL 而不是 BIGSERIAL 當 id', () => {
  // 用 grep 看：CREATE TABLE 後面到下一個 ); 之間的 id 欄位
  const tables = [
    'bug_reports',
    'bug_report_declines',
    'bug_report_spam_suspects',
    'bug_report_spam_blocks',
    'bug_report_notification_mutes',
  ];
  for (const t of tables) {
    const re = new RegExp(`CREATE\\s+TABLE\\s+${t}\\s*\\([\\s\\S]*?id\\s+SERIAL\\s+PRIMARY\\s+KEY`, 'i');
    assert.match(sql, re, `${t}.id 應是 SERIAL PRIMARY KEY`);
  }
});

test('真實 declaration 沒有 BIGSERIAL（註解可以有、解釋用）', () => {
  // 把所有單行註解（-- ...）跟區塊註解過濾掉、只看實際 SQL
  const sqlNoComments = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, '')) // 去掉行內註解
    .join('\n');
  assert.doesNotMatch(
    sqlNoComments,
    /BIGSERIAL/i,
    'migration 017 的實際 SQL declaration 不該再用 BIGSERIAL（只允許出現在註解裡解釋）'
  );
});

// ============================================================
// report_ids 從 BIGINT[] 改 INT[]
// ============================================================

test('bug_report_spam_suspects.report_ids 改成 INT[]、不是 BIGINT[]', () => {
  assert.match(sql, /report_ids\s+INT\[\]\s+NOT\s+NULL/i);
  // 確認沒有 BIGINT[] 殘留
  assert.doesNotMatch(sql, /report_ids\s+BIGINT\[\]/i);
});

// ============================================================
// CHECK constraint 全部重建
// ============================================================

test('重建後 bug_reports 三個 CHECK constraint 都有', () => {
  for (const c of [
    'bug_reports_severity_check',
    'bug_reports_status_check',
    'bug_reports_status_reason_check',
  ]) {
    assert.match(sql, new RegExp(`CONSTRAINT\\s+${c}`, 'i'), `應重建 ${c}`);
  }
});

test('重建後 spam_suspects 兩個 CHECK constraint 都有', () => {
  for (const c of [
    'bug_report_spam_suspects_trigger_rule_check',
    'bug_report_spam_suspects_status_check',
  ]) {
    assert.match(sql, new RegExp(`CONSTRAINT\\s+${c}`, 'i'), `應重建 ${c}`);
  }
});

test('重建後 notification_mutes 兩個 CHECK constraint 都有', () => {
  for (const c of [
    'bug_report_notification_mutes_target_check',
    'bug_report_notification_mutes_target_value_check',
  ]) {
    assert.match(sql, new RegExp(`CONSTRAINT\\s+${c}`, 'i'), `應重建 ${c}`);
  }
});

// ============================================================
// 所有 index 全部重建
// ============================================================

test('六個 index 全部重建', () => {
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
      `應重建 index ${idx}`
    );
  }
});

// ============================================================
// 預設值跟原本一樣（blocked_until +24h、muted_until +30天）
// ============================================================

test('blocked_until 預設仍是 +24 hours', () => {
  assert.match(sql, /blocked_until[^,]+DEFAULT\s+\(now\(\)\s*\+\s*INTERVAL\s+'24\s+hours'/i);
});

test('muted_until 預設仍是 +30 days', () => {
  assert.match(sql, /muted_until[^,]+DEFAULT\s+\(now\(\)\s*\+\s*INTERVAL\s+'30\s+days'/i);
});
