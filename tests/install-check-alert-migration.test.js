// tests/install-check-alert-migration.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('021_install_check_alert_state migration', () => {
  const sql = readFileSync(new URL('../db/021_install_check_alert_state.sql', import.meta.url), 'utf8');

  it('creates the table idempotently', () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS install_check_alert_state/);
  });

  it('keys a failure by user, machine and check name', () => {
    assert.match(sql, /UNIQUE\s*\(\s*user_id\s*,\s*machine\s*,\s*check_name\s*\)/);
  });

  it('cascades when a user is deleted, like install_check_logs does', () => {
    assert.match(sql, /REFERENCES\s+users\s*\(\s*id\s*\)\s+ON DELETE CASCADE/);
  });

  it('carries the three timestamps the evaluator reads', () => {
    for (const col of ['first_seen_at', 'announced_at', 'resolved_at']) {
      assert.match(sql, new RegExp(`\\b${col}\\b`), `${col} missing`);
    }
  });
});
