/**
 * Tests for hooks/lib/bypass-handler.js
 *
 * v1.19.6 — Bypass channel + audit log
 *
 * Design:
 *   - OWNMIND_BYPASS=IR-008,IR-024 → parsed into a Set
 *   - OWNMIND_BYPASS=all → covers every rule
 *   - Process scope (parsing must not mutate env)
 *   - logBypass writes the audit entry
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
  it('empty env → empty Set', () => {
    assert.equal(parseBypass({}).size, 0);
    assert.equal(parseBypass({ OWNMIND_BYPASS: '' }).size, 0);
    assert.equal(parseBypass(null).size, 0);
    assert.equal(parseBypass(undefined).size, 0);
  });

  it('single rule', () => {
    const s = parseBypass({ OWNMIND_BYPASS: 'IR-008' });
    assert.equal(s.size, 1);
    assert.ok(s.has('IR-008'));
  });

  it('multiple rules (comma-separated)', () => {
    const s = parseBypass({ OWNMIND_BYPASS: 'IR-008,IR-024,IR-031' });
    assert.equal(s.size, 3);
    assert.ok(s.has('IR-008'));
    assert.ok(s.has('IR-024'));
    assert.ok(s.has('IR-031'));
  });

  it('multiple rules — whitespace auto-trimmed', () => {
    const s = parseBypass({ OWNMIND_BYPASS: ' IR-008 , IR-024 ' });
    assert.equal(s.size, 2);
    assert.ok(s.has('IR-008'));
    assert.ok(s.has('IR-024'));
  });

  it('all keyword', () => {
    const s = parseBypass({ OWNMIND_BYPASS: 'all' });
    assert.equal(s.size, 1);
    assert.ok(s.has('all'));
  });

  it('ALL / All case-insensitive, normalized to all', () => {
    assert.ok(parseBypass({ OWNMIND_BYPASS: 'ALL' }).has('all'));
    assert.ok(parseBypass({ OWNMIND_BYPASS: 'All' }).has('all'));
    assert.ok(parseBypass({ OWNMIND_BYPASS: 'aLL' }).has('all'));
  });

  it('mixed: IR-008,ALL → contains IR-008 and the normalized all', () => {
    const s = parseBypass({ OWNMIND_BYPASS: 'IR-008,ALL,IR-024' });
    assert.ok(s.has('IR-008'));
    assert.ok(s.has('IR-024'));
    assert.ok(s.has('all'));
  });

  it('parsing must not mutate the env object', () => {
    const env = { OWNMIND_BYPASS: 'IR-008' };
    parseBypass(env);
    assert.equal(env.OWNMIND_BYPASS, 'IR-008');
  });

  it('non-string value → empty Set', () => {
    const s = parseBypass({ OWNMIND_BYPASS: 123 });
    assert.equal(s.size, 0);
  });
});

// ============================================================
// isBypassed
// ============================================================

describe('isBypassed', () => {
  it('rule is in the set → true', () => {
    assert.equal(isBypassed('IR-008', new Set(['IR-008'])), true);
  });

  it('rule is not in the set → false', () => {
    assert.equal(isBypassed('IR-005', new Set(['IR-008'])), false);
  });

  it('bypass=all → every rule is true', () => {
    const s = new Set(['all']);
    assert.equal(isBypassed('IR-002', s), true);
    assert.equal(isBypassed('IR-999', s), true);
  });

  it('empty set → false', () => {
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

  it('writes one action=bypass entry into compliance.jsonl', () => {
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

  it('supports optional fields: commit_hash / session_id / failures', () => {
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

  it('missing ruleTitle → falls back to ruleCode', () => {
    logBypass({ ruleCode: 'IR-999', source: 'hook' });
    const entry = JSON.parse(fs.readFileSync(TEST_LOG_FILE, 'utf8').trim());
    assert.equal(entry.rule_title, 'IR-999');
  });
});
