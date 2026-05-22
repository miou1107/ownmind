/**
 * Tests for hooks/lib/bypass-handler.js
 *
 * v1.19.6 — 放行通道（Bypass）+ audit log
 *
 * 設計：
 *   - OWNMIND_BYPASS=IR-008,IR-024 → 解析成 Set
 *   - OWNMIND_BYPASS=all → 涵蓋所有規則
 *   - process scope（解析時不修改 env）
 *   - logBypass 寫 audit
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TEST_LOG_DIR = path.join(os.tmpdir(), 'ownmind-bypass-test-' + Date.now());
const TEST_LOG_FILE = path.join(TEST_LOG_DIR, 'compliance.jsonl');

process.env.__OWNMIND_COMPLIANCE_LOG_PATH = TEST_LOG_FILE;

const {
  parseBypass,
  isBypassed,
  logBypass,
} = await import('../hooks/lib/bypass-handler.js');

// ============================================================
// parseBypass
// ============================================================

describe('parseBypass', () => {
  it('空環境 → 空 Set', () => {
    assert.equal(parseBypass({}).size, 0);
    assert.equal(parseBypass({ OWNMIND_BYPASS: '' }).size, 0);
    assert.equal(parseBypass(null).size, 0);
    assert.equal(parseBypass(undefined).size, 0);
  });

  it('單條規則', () => {
    const s = parseBypass({ OWNMIND_BYPASS: 'IR-008' });
    assert.equal(s.size, 1);
    assert.ok(s.has('IR-008'));
  });

  it('多條規則（逗號分隔）', () => {
    const s = parseBypass({ OWNMIND_BYPASS: 'IR-008,IR-024,IR-031' });
    assert.equal(s.size, 3);
    assert.ok(s.has('IR-008'));
    assert.ok(s.has('IR-024'));
    assert.ok(s.has('IR-031'));
  });

  it('多條規則 — 自動 trim 空白', () => {
    const s = parseBypass({ OWNMIND_BYPASS: ' IR-008 , IR-024 ' });
    assert.equal(s.size, 2);
    assert.ok(s.has('IR-008'));
    assert.ok(s.has('IR-024'));
  });

  it('all 關鍵字', () => {
    const s = parseBypass({ OWNMIND_BYPASS: 'all' });
    assert.equal(s.size, 1);
    assert.ok(s.has('all'));
  });

  it('ALL / All 大小寫 case-insensitive normalize 成 all', () => {
    assert.ok(parseBypass({ OWNMIND_BYPASS: 'ALL' }).has('all'));
    assert.ok(parseBypass({ OWNMIND_BYPASS: 'All' }).has('all'));
    assert.ok(parseBypass({ OWNMIND_BYPASS: 'aLL' }).has('all'));
  });

  it('混用：IR-008,ALL → 含 IR-008 與 normalize 後的 all', () => {
    const s = parseBypass({ OWNMIND_BYPASS: 'IR-008,ALL,IR-024' });
    assert.ok(s.has('IR-008'));
    assert.ok(s.has('IR-024'));
    assert.ok(s.has('all'));
  });

  it('解析時不修改 env 物件', () => {
    const env = { OWNMIND_BYPASS: 'IR-008' };
    parseBypass(env);
    assert.equal(env.OWNMIND_BYPASS, 'IR-008');
  });

  it('非字串值 → 空 Set', () => {
    const s = parseBypass({ OWNMIND_BYPASS: 123 });
    assert.equal(s.size, 0);
  });
});

// ============================================================
// isBypassed
// ============================================================

describe('isBypassed', () => {
  it('規則在 set 中 → true', () => {
    assert.equal(isBypassed('IR-008', new Set(['IR-008'])), true);
  });

  it('規則不在 set 中 → false', () => {
    assert.equal(isBypassed('IR-005', new Set(['IR-008'])), false);
  });

  it('bypass=all → 任何規則都 true', () => {
    const s = new Set(['all']);
    assert.equal(isBypassed('IR-002', s), true);
    assert.equal(isBypassed('IR-999', s), true);
  });

  it('空 set → false', () => {
    assert.equal(isBypassed('IR-008', new Set()), false);
  });

  it('null/undefined set → false', () => {
    assert.equal(isBypassed('IR-008', null), false);
    assert.equal(isBypassed('IR-008', undefined), false);
  });
});

// ============================================================
// logBypass
// ============================================================

describe('logBypass', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
    try { fs.unlinkSync(TEST_LOG_FILE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_LOG_DIR, { recursive: true }); } catch {}
  });

  it('寫一筆 action=bypass 進 compliance.jsonl', () => {
    logBypass({
      ruleCode: 'IR-008',
      ruleTitle: '同步文件',
      source: 'pre_commit',
    });

    const raw = fs.readFileSync(TEST_LOG_FILE, 'utf8').trim();
    const entry = JSON.parse(raw);
    assert.equal(entry.action, 'bypass');
    assert.equal(entry.rule_code, 'IR-008');
    assert.equal(entry.rule_title, '同步文件');
    assert.equal(entry.source, 'pre_commit');
    assert.ok(entry.ts);
  });

  it('支援可選欄位：commit_hash / session_id / failures', () => {
    logBypass({
      ruleCode: 'IR-002',
      ruleTitle: '不要 commit .env',
      source: 'pre_commit',
      commitHash: 'abc1234',
      sessionId: 'sess-xyz',
      failures: ['偵測到 .env 進入 commit'],
    });

    const entry = JSON.parse(fs.readFileSync(TEST_LOG_FILE, 'utf8').trim());
    assert.equal(entry.commit_hash, 'abc1234');
    assert.equal(entry.session_id, 'sess-xyz');
    assert.deepEqual(entry.failures, ['偵測到 .env 進入 commit']);
  });

  it('ruleTitle 缺 → fallback 用 ruleCode', () => {
    logBypass({ ruleCode: 'IR-999', source: 'hook' });
    const entry = JSON.parse(fs.readFileSync(TEST_LOG_FILE, 'utf8').trim());
    assert.equal(entry.rule_title, 'IR-999');
  });
});
