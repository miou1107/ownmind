import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';
import { logCheckFailure, _logPathForTests, MAX_LOG_BYTES } from '../hooks/lib/check-failure-log.js';

/**
 * v1.30.2 — the sink for why a reply check did not run.
 *
 * The notice the user reads carries no error text by design: "timeout", "http 401" and
 * "unknown" are exactly the internal vocabulary the message rules forbid. That decision left
 * the reason with nowhere to go at all, so a revoked key and a two-second network blip
 * produced the same sentence, forever, with nothing on the machine to tell them apart. This
 * file is where the detail lands instead.
 */

let dir;
let logFile;

beforeEach(() => {
  dir = tempDir('om-check-failure-log-');
  logFile = path.join(dir, 'check-failures.jsonl');
  _logPathForTests(logFile);
});

afterEach(() => { _logPathForTests(null); });

test('a failure is recorded with what failed, why, and when', () => {
  assert.equal(logCheckFailure({ sessionId: 's1', failure: 'unauthorized', reason: 'http 401' }), true);
  const [line, ...rest] = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  assert.deepEqual(rest, []);
  const record = JSON.parse(line);
  assert.equal(record.session_id, 's1');
  assert.equal(record.failure, 'unauthorized');
  assert.equal(record.reason, 'http 401');
  assert.equal(record.check_id, null, 'nothing reached the server, so there is no row to point at');
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('a failure the server recorded keeps the id of that record', () => {
  logCheckFailure({ sessionId: 's1', failure: 'server-declined', reason: 'server answered failed', checkId: 77 });
  const record = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
  assert.equal(record.check_id, 77);
});

test('every occurrence is kept, because "when did this start" is the question being asked', () => {
  logCheckFailure({ sessionId: 's1', failure: 'timeout', reason: 'timeout' });
  logCheckFailure({ sessionId: 's1', failure: 'timeout', reason: 'timeout' });
  assert.equal(fs.readFileSync(logFile, 'utf8').trim().split('\n').length, 2);
});

test('a record with nothing filled in still says a check did not run', () => {
  assert.equal(logCheckFailure({}), true);
  const record = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
  assert.equal(record.session_id, 'unknown');
  assert.equal(record.failure, 'unknown');
  assert.equal(record.reason, 'unknown');
});

test('the file is rotated rather than allowed to grow without limit', () => {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, 'x'.repeat(MAX_LOG_BYTES + 1));
  logCheckFailure({ sessionId: 's1', failure: 'network', reason: 'ECONNREFUSED' });
  assert.ok(fs.existsSync(`${logFile}.old`), 'the previous file is kept, once');
  assert.equal(fs.readFileSync(logFile, 'utf8').trim().split('\n').length, 1);
});

test('a log that cannot be written says so and never throws', () => {
  // The caller is a hook on the critical path of every reply. A diagnosis that can break the
  // check it is diagnosing is a worse defect than the missing diagnosis.
  _logPathForTests(path.join(dir, 'a-file', 'nested', 'check-failures.jsonl'));
  fs.writeFileSync(path.join(dir, 'a-file'), 'not a directory');
  assert.equal(logCheckFailure({ sessionId: 's1', failure: 'network', reason: 'x' }), false);
});
