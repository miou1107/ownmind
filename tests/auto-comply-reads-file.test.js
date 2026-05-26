import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { evaluateConditions } from '../shared/verification.js';
import { appendCompliance, readComplianceEvents } from '../shared/compliance.js';

/**
 * v1.20.2 follow-up: autoComply should read from the file, not just in-memory complianceEvents.
 *
 * Background:
 * - MCP's ownmind_report_compliance has an "E3: Auto-verify on trigger detection" block in the
 *   case handler (mcp/index.js:1090-1129) that runs an IR-025-style check and blocks on failure.
 * - Originally it used an in-memory `complianceEvents` array, so a session restart (MCP process
 *   restart) wiped the state.
 * - The pre-commit hook switched to reading via readComplianceEvents from the jsonl file, so the
 *   hook-pass / autoComply-block paths diverged.
 * - Fix: have autoComply also read from the file so it agrees with the hook.
 *
 * This test pins the design contract:
 *   GIVEN in-memory is empty (simulated session restart)
 *   AND the file has fresh "verification" + "code-review" comply entries
 *   WHEN we run the IR-025 conditions
 *   THEN pass=true, no block.
 */

const TMP_LOG = path.join(os.tmpdir(), `ownmind-test-compliance-${process.pid}.jsonl`);

const IR025_CONDITIONS = {
  operator: 'AND',
  checks: [
    {
      type: 'recent_event_exists',
      params: { event: 'verification', action: 'comply' },
      message: '還沒做 verification'
    },
    {
      type: 'recent_event_exists',
      params: { event: 'code-review', action: 'comply' },
      message: '還沒做 code review'
    }
  ]
};

describe('v1.20.2 follow-up: autoComply reads the file, not just in-memory', () => {
  before(() => {
    process.env.__OWNMIND_COMPLIANCE_LOG_PATH = TMP_LOG;
    // Clear leftovers from prior test runs.
    if (fs.existsSync(TMP_LOG)) fs.unlinkSync(TMP_LOG);
  });

  after(() => {
    if (fs.existsSync(TMP_LOG)) fs.unlinkSync(TMP_LOG);
    delete process.env.__OWNMIND_COMPLIANCE_LOG_PATH;
  });

  it('in-memory empty, file has verification + code-review → IR-025 passes', () => {
    // Write two fresh comply entries into the file, simulating QA done in a previous session.
    appendCompliance({
      event: 'verification',
      action: 'comply',
      rule_code: '',
      rule_title: 'verification',
      source: 'mcp',
    });
    appendCompliance({
      event: 'code-review',
      action: 'comply',
      rule_code: '',
      rule_title: 'code-review',
      source: 'mcp',
    });

    // Simulate session restart: in-memory array is empty, ctx reads from the file.
    const fileEvents = readComplianceEvents();
    assert.equal(fileEvents.length, 2, 'the file should yield 2 fresh comply entries');

    // Run IR-025 conditions, expect pass=true.
    const ctx = { complianceEvents: fileEvents };
    const result = evaluateConditions(IR025_CONDITIONS, ctx);
    assert.equal(result.pass, true,
      `expected pass=true, actual failures: ${JSON.stringify(result.failures)}`);
    assert.deepEqual(result.failures, []);
  });

  it('counter-proof: reading only in-memory (empty array) incorrectly blocks — proves the original bug', () => {
    // Even though the file has two fresh comply entries, an empty in-memory blocks.
    const inMemoryOnly = []; // simulates in-memory after a session restart
    const ctx = { complianceEvents: inMemoryOnly };
    const result = evaluateConditions(IR025_CONDITIONS, ctx);
    assert.equal(result.pass, false, 'original bug: looking only at in-memory wrongly blocks');
    assert.equal(result.failures.length, 2);
  });

  it('merge file + in-memory: when both sources have data, should pass', () => {
    // Scenario: verification was called in this session (in-memory has it); the file
    // already accumulated a code-review entry.
    const inMemory = [
      { event: 'verification', action: 'comply', ts: new Date().toISOString() }
    ];
    const fileEvents = readComplianceEvents();
    const merged = [...inMemory, ...fileEvents];
    const ctx = { complianceEvents: merged };
    const result = evaluateConditions(IR025_CONDITIONS, ctx);
    assert.equal(result.pass, true, 'merged sources, expected pass');
  });
});
