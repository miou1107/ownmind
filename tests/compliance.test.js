import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Use a temp dir to avoid polluting real logs
const TEST_LOG_DIR = path.join(os.tmpdir(), 'ownmind-compliance-test-' + Date.now());
const TEST_LOG_FILE = path.join(TEST_LOG_DIR, 'compliance.jsonl');

// We need to set env before import so compliance.js picks up the test path
process.env.__OWNMIND_COMPLIANCE_LOG_PATH = TEST_LOG_FILE;

const { appendCompliance, readComplianceEvents } = await import('../shared/compliance.js');

describe('appendCompliance', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
    try { fs.unlinkSync(TEST_LOG_FILE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_LOG_DIR, { recursive: true }); } catch {}
  });

  it('writes a valid JSONL entry with auto-generated ts', () => {
    appendCompliance({
      event: 'IR-008',
      action: 'comply',
      rule_code: 'IR-008',
      rule_title: '每次 commit 必須同步更新文件',
      source: 'mcp',
    });

    const lines = fs.readFileSync(TEST_LOG_FILE, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, 'IR-008');
    assert.equal(entry.action, 'comply');
    assert.equal(entry.rule_code, 'IR-008');
    assert.equal(entry.source, 'mcp');
    assert.ok(entry.ts, 'ts should be auto-generated');
  });

  it('preserves optional fields: session_id, commit_hash, failures', () => {
    appendCompliance({
      event: 'IR-002',
      action: 'violate',
      rule_code: 'IR-002',
      rule_title: '不要 commit .env',
      source: 'post_commit',
      session_id: '123',
      commit_hash: 'abc1234',
      failures: ['staged .env file'],
    });

    const entry = JSON.parse(fs.readFileSync(TEST_LOG_FILE, 'utf8').trim());
    assert.equal(entry.commit_hash, 'abc1234');
    assert.deepEqual(entry.failures, ['staged .env file']);
    assert.equal(entry.session_id, '123');
  });
});

describe('readComplianceEvents', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
    try { fs.unlinkSync(TEST_LOG_FILE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_LOG_DIR, { recursive: true }); } catch {}
  });

  it('returns empty array when log does not exist', () => {
    const events = readComplianceEvents();
    assert.deepEqual(events, []);
  });

  it('filters events by cutoff', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 1000).toISOString();
    const old = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    fs.writeFileSync(TEST_LOG_FILE, [
      JSON.stringify({ ts: old, event: 'IR-001', action: 'comply', rule_code: 'IR-001', rule_title: 'old', source: 'mcp' }),
      JSON.stringify({ ts: recent, event: 'IR-002', action: 'comply', rule_code: 'IR-002', rule_title: 'recent', source: 'mcp' }),
    ].join('\n') + '\n');

    const events = readComplianceEvents(24 * 60 * 60 * 1000);
    assert.equal(events.length, 1);
    assert.equal(events[0].rule_code, 'IR-002');
  });

  it('skips malformed lines', () => {
    fs.writeFileSync(TEST_LOG_FILE, 'not json\n' + JSON.stringify({
      ts: new Date().toISOString(), event: 'IR-001', action: 'comply',
      rule_code: 'IR-001', rule_title: 'test', source: 'mcp'
    }) + '\n');

    const events = readComplianceEvents();
    assert.equal(events.length, 1);
  });
});
