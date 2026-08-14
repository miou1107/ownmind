/**
 * Tests for action gate guard matching.
 */

import { strict as assert } from 'assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { matchGuards, evaluateGate, approveAction } from '../hooks/lib/action-gate.js';
import { ensureKey, ensureNonce } from '../hooks/lib/gate-receipt.js';
import { tempDir } from './helpers/temp-dir.js';

const DEPLOY_GUARD = {
  id: 918,
  kind: 'action',
  triggers: ['deploy'],
  checks: [],
  read_required: true,
  ask_first: false,
  rule_text: 'x',
  rules_hash: 'h',
};

test('a compose build command matches a deploy guard', () => {
  assert.equal(
    matchGuards('docker compose build --no-cache api', [DEPLOY_GUARD]).length,
    1
  );
});

test('a version-tag push is a deploy even though the classifier calls it git', () => {
  assert.equal(matchGuards('git push origin ima-v1.2.9', [DEPLOY_GUARD]).length, 1);
  assert.equal(matchGuards('git push origin v0.35.13', [DEPLOY_GUARD]).length, 1);
});

test('everyday commands match nothing', () => {
  for (const cmd of [
    'ls -la',
    'git status',
    'git grep "docker build"',
    'npm test',
  ]) {
    assert.equal(
      matchGuards(cmd, [DEPLOY_GUARD]).length,
      0,
      `should not match: ${cmd}`
    );
  }
});

test('null or undefined or empty command returns empty array', () => {
  assert.deepEqual(matchGuards(null, [DEPLOY_GUARD]), []);
  assert.deepEqual(matchGuards(undefined, [DEPLOY_GUARD]), []);
  assert.deepEqual(matchGuards('', [DEPLOY_GUARD]), []);
  assert.deepEqual(matchGuards('   ', [DEPLOY_GUARD]), []);
});

test('guards array null or undefined is handled safely', () => {
  assert.deepEqual(matchGuards('docker compose up', null), []);
  assert.deepEqual(matchGuards('docker compose up', undefined), []);
});

test('guards lacking triggers are filtered out', () => {
  const guardNoTriggers = {
    id: 999,
    kind: 'action',
    triggers: [],
    checks: [],
    read_required: false,
    ask_first: false,
    rule_text: 'x',
    rules_hash: 'h',
  };
  assert.equal(matchGuards('docker compose build', [guardNoTriggers]).length, 0);
});

test('guards with non-action kind are filtered out', () => {
  const notActionGuard = {
    id: 999,
    kind: 'notification',
    triggers: ['deploy'],
    checks: [],
    read_required: false,
    ask_first: false,
    rule_text: 'x',
    rules_hash: 'h',
  };
  assert.equal(
    matchGuards('docker compose build', [notActionGuard]).length,
    0
  );
});

test('multiple guards are matched correctly', () => {
  const commitGuard = {
    id: 100,
    kind: 'action',
    triggers: ['commit'],
    checks: [],
    read_required: false,
    ask_first: false,
    rule_text: 'x',
    rules_hash: 'h',
  };
  const deployGuard = DEPLOY_GUARD;

  // git commit should match only commitGuard
  const commitMatches = matchGuards('git commit -m "test"', [
    commitGuard,
    deployGuard,
  ]);
  assert.equal(commitMatches.length, 1);
  assert.equal(commitMatches[0].id, 100);

  // docker compose up should match only deployGuard
  const deployMatches = matchGuards('docker compose up', [
    commitGuard,
    deployGuard,
  ]);
  assert.equal(deployMatches.length, 1);
  assert.equal(deployMatches[0].id, 918);
});

test('applies_pattern restricts guard matching', () => {
  const deployGuardWithPattern = {
    id: 950,
    kind: 'action',
    triggers: ['deploy'],
    checks: [],
    read_required: true,
    ask_first: false,
    rule_text: 'x',
    rules_hash: 'h',
    applies_pattern: 'git\\s+push\\b.*\\s(refs\\/tags\\/)?(v\\d|ima-v|ima-rc)|docker\\s+compose',
  };

  // Should NOT match plain git push
  assert.equal(
    matchGuards('git push origin main', [deployGuardWithPattern]).length,
    0,
    'plain git push should not match pattern'
  );
  assert.equal(
    matchGuards('git push origin feature-x', [deployGuardWithPattern]).length,
    0,
    'feature branch push should not match pattern'
  );

  // Should match version-tag push
  assert.equal(
    matchGuards('git push origin ima-v1.2.9', [deployGuardWithPattern]).length,
    1,
    'version-tag push should match pattern'
  );

  // Should match docker compose
  assert.equal(
    matchGuards('docker compose build --no-cache api', [
      deployGuardWithPattern,
    ]).length,
    1,
    'docker compose should match pattern'
  );
});

test('invalid applies_pattern regex still fires guard', () => {
  const deployGuardWithInvalidPattern = {
    id: 951,
    kind: 'action',
    triggers: ['deploy'],
    checks: [],
    read_required: true,
    ask_first: false,
    rule_text: 'x',
    rules_hash: 'h',
    applies_pattern: '(',
  };

  // Even though pattern is invalid, guard should still match (fail toward enforcement)
  assert.equal(
    matchGuards('docker compose build', [deployGuardWithInvalidPattern]).length,
    1,
    'invalid regex should still allow guard to fire'
  );
});

test('guard without applies_pattern field works as before', () => {
  const deployGuardNoPattern = {
    id: 952,
    kind: 'action',
    triggers: ['deploy'],
    checks: [],
    read_required: true,
    ask_first: false,
    rule_text: 'x',
    rules_hash: 'h',
  };

  // Should match any deploy command
  assert.equal(
    matchGuards('git push origin main', [deployGuardNoPattern]).length,
    1
  );
  assert.equal(
    matchGuards('docker compose build', [deployGuardNoPattern]).length,
    1
  );
});

test('non-array guards are handled safely without throwing', () => {
  // Truthy non-array values should not throw, but return []
  assert.deepEqual(matchGuards('docker compose up', 'oops'), []);
  assert.deepEqual(matchGuards('docker compose up', {}), []);
  assert.deepEqual(matchGuards('docker compose up', 42), []);
  assert.deepEqual(matchGuards('docker compose up', true), []);
});

test('refs/tags/ push format is recognized as a version-tag deployment', () => {
  assert.equal(
    matchGuards('git push origin refs/tags/v1.2.9', [DEPLOY_GUARD]).length,
    1,
    'refs/tags/ format should match deploy guard'
  );
});

// --- evaluateGate / approveAction (the decision core) ---

function prepStateDir() {
  const dir = tempDir('gate-eval-');
  ensureKey(dir);
  ensureNonce(dir, 's1');
  return dir;
}

function mkGuard(over = {}) {
  return { id: 918, kind: 'action', title: 'compose no-cache', triggers: ['deploy'],
    checks: [
      { type: 'must_not_match', pattern: '(^|\\s)docker\\s+build(\\s|$)', reason: 'use docker compose build (IR-023)' },
      { type: 'must_match', pattern: '--no-cache', reason: 'add --no-cache (IR-018)' },
    ],
    read_required: true, ask_first: false,
    rule_text: 'Deploys use docker compose build --no-cache.',
    rules_hash: createHash('sha256').update('Deploys use docker compose build --no-cache.').digest('hex'),
    ...over };
}

test('unread rule blocks with the rule text, and the retry passes gate 1', () => {
  const dir = prepStateDir(); const g = mkGuard();
  const first = evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(first.action, 'block'); assert.equal(first.kind, 'read');
  assert.match(first.reason, /docker compose build --no-cache/);
  const second = evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(second.action, 'allow');
});

test('a read but non-compliant command blocks with the specific reason', () => {
  const dir = prepStateDir(); const g = mkGuard();
  evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  const r = evaluateGate({ command: 'docker compose build api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(r.action, 'block'); assert.equal(r.kind, 'check');
  assert.match(r.reason, /--no-cache/);
});

test('the third consecutive block becomes stop-and-ask, never an allow', () => {
  const dir = prepStateDir(); const g = mkGuard();
  evaluateGate({ command: 'docker compose build --no-cache x', guards: [g], stateDir: dir, sessionId: 's1' }); // read
  for (let i = 0; i < 2; i += 1) {
    assert.equal(evaluateGate({ command: 'docker build .', guards: [g], stateDir: dir, sessionId: 's1' }).kind, 'check');
  }
  const third = evaluateGate({ command: 'docker build .', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(third.kind, 'limit');
  assert.match(third.userLine, /\d{6}/, 'the user line carries the approval code');
  assert.ok(!third.reason.match(/\d{6}/), 'the model-facing reason must NOT contain the code');
});

test('ask_first blocks until the code is approved, then allows exactly once', () => {
  const dir = prepStateDir(); const g = mkGuard({ ask_first: true, checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(ask.kind, 'ask');
  const code = ask.userLine.match(/(\d{6})/)[1];
  assert.equal(approveAction(dir, 's1', g.id, code), true);
  assert.equal(evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' }).action, 'allow');
  const again = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(again.kind, 'ask', 'approval is one-shot');
});

// --- Amendment 2: Critical & Important fixes ---

test('C1: gate-log never contains approval code or userLine', () => {
  const dir = prepStateDir(); const g = mkGuard({ ask_first: true, checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  const code = ask.userLine.match(/(\d{6})/)[1];
  approveAction(dir, 's1', g.id, code);

  // Read gate-log and verify no code or userLine appears
  const logFile = path.join(dir, 'gate-log.jsonl');
  const logContent = fs.readFileSync(logFile, 'utf8');
  assert.ok(!logContent.includes(code), 'approval code must not appear in log');
  assert.ok(!logContent.includes('Approval code:'), 'userLine text must not appear in log');

  // Verify log has code_issued flag
  const entries = logContent.trim().split('\n').map(l => JSON.parse(l));
  const askEntry = entries.find(e => e.kind === 'ask');
  assert.equal(askEntry.code_issued, true, 'ask entry must have code_issued flag');
});

test('C2: receipt subsystem failure sets degraded flag without throwing', () => {
  const nonexistentDir = '/tmp/this-dir-does-not-exist-' + Math.random();
  // Guard with read_required, checks that match --no-cache requirement
  const g = mkGuard({ read_required: true });

  // First call: good command but receipt fails → allow with degraded (checks pass)
  const result = evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: nonexistentDir, sessionId: 's1' });
  assert.equal(result.action, 'allow', 'good command allows despite degraded receipt');
  assert.equal(result.degraded, 'no-receipts', 'missing receipt must set degraded flag');

  // Second call: bad command (violates checks) → check block even though receipt degraded
  const badCmd = evaluateGate({ command: 'docker build .', guards: [g], stateDir: nonexistentDir, sessionId: 's1' });
  assert.equal(badCmd.kind, 'check', 'checks still enforce on degraded read');
  assert.equal(badCmd.degraded, 'no-receipts', 'degraded flag persists');
});

test('I1: limit approvals are redeemable (consume approval, clear counter, allow once)', () => {
  const dir = prepStateDir(); const g = mkGuard();
  evaluateGate({ command: 'docker compose build --no-cache x', guards: [g], stateDir: dir, sessionId: 's1' }); // read

  // Three check blocks
  for (let i = 0; i < 3; i += 1) {
    evaluateGate({ command: 'docker build .', guards: [g], stateDir: dir, sessionId: 's1' });
  }

  // Fourth attempt → limit
  const limit = evaluateGate({ command: 'docker build .', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(limit.kind, 'limit');
  const code = limit.userLine.match(/(\d{6})/)[1];

  // Approve and retry
  approveAction(dir, 's1', g.id, code);
  const allowed = evaluateGate({ command: 'docker build .', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(allowed.action, 'allow', 'approved command should allow');

  // Next time checks apply again (counter cleared)
  const nextCheck = evaluateGate({ command: 'docker build .', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(nextCheck.kind, 'check', 'after consuming approval, checks apply again');
});

test('I2: approvals consumed only when whole command ends in allow', () => {
  const dir = prepStateDir();
  const gA = mkGuard({ id: 100, ask_first: true, checks: [], read_required: false });
  const gB = mkGuard({ id: 200, checks: [{ type: 'must_match', pattern: '--no-cache', reason: 'need --no-cache' }], read_required: false, ask_first: false });

  // First: ask_first guard asks
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [gA], stateDir: dir, sessionId: 's1' });
  const code = ask.userLine.match(/(\d{6})/)[1];
  approveAction(dir, 's1', gA.id, code);

  // Now evaluate with both guards: A approved, B fails
  const result = evaluateGate({ command: 'docker compose build api', guards: [gA, gB], stateDir: dir, sessionId: 's1' });
  assert.equal(result.kind, 'check', 'B blocks even though A approved');

  // A's approval should NOT be consumed yet
  // Fix B and retry
  const allowed = evaluateGate({ command: 'docker compose build --no-cache api', guards: [gA, gB], stateDir: dir, sessionId: 's1' });
  assert.equal(allowed.action, 'allow', 'now both allow');

  // A's approval was consumed by the allow
  const retry = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [gA], stateDir: dir, sessionId: 's1' });
  assert.equal(retry.kind, 'ask', 'A needs approval again');
});

test('I3: docker build matches deploy, quoted mentions and grep do not', () => {
  assert.equal(matchGuards('docker build .', [DEPLOY_GUARD]).length, 1, 'bare docker build matches');
  assert.equal(matchGuards('docker build -t myimage .', [DEPLOY_GUARD]).length, 1, 'docker build with args matches');
  assert.equal(matchGuards('echo "docker build ."', [DEPLOY_GUARD]).length, 0, 'quoted mention does not match');
  assert.equal(matchGuards('git grep "docker build"', [DEPLOY_GUARD]).length, 0, 'grep does not match');
});

test('I4: approveAction validates sessionId and guardId', () => {
  const dir = prepStateDir(); const g = mkGuard({ ask_first: true, checks: [], read_required: false });

  // Test 1: Valid sessionId and guardId
  const ask1 = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  const code1 = ask1.userLine.match(/(\d{6})/)[1];
  assert.equal(approveAction(dir, 's1', 918, code1), true, 'valid approval');
  // After approval, next eval consumes it and allows
  const allowed1 = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(allowed1.action, 'allow', 'approved ask allows once');

  // Test 2: bad sessionId (with path traversal attempt) → should sanitize to 'unknown' and fail
  const ask2 = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  const code2 = ask2.userLine.match(/(\d{6})/)[1];
  assert.equal(approveAction(dir, '../etc/passwd', 918, code2), false, 'bad sessionId (path traversal) should not approve');

  // Test 3: guardId validation - negative
  const ask3 = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  const code3 = ask3.userLine.match(/(\d{6})/)[1];
  assert.equal(approveAction(dir, 's1', -1, code3), false, 'negative guardId should not approve');

  // Test 4: guardId validation - non-integer
  const ask4 = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  const code4 = ask4.userLine.match(/(\d{6})/)[1];
  assert.equal(approveAction(dir, 's1', 'not-a-number', code4), false, 'non-integer guardId should not approve');

  // Test 5: guardId validation - zero
  const ask5 = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  const code5 = ask5.userLine.match(/(\d{6})/)[1];
  assert.equal(approveAction(dir, 's1', 0, code5), false, 'zero guardId should not approve');
});

// --- Re-review breakages from Amendment 2 wave ---

test('NEW-1: ask_first approval must NOT bypass regex checks (security)', () => {
  const dir = prepStateDir();
  const g = mkGuard({ id: 888, ask_first: true, checks: [{ type: 'must_not_match', pattern: '\\-\\-force', reason: 'no force push' }], read_required: false });

  // First: ask_first blocks, get approval code
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(ask.kind, 'ask');
  const code = ask.userLine.match(/(\d{6})/)[1];

  // Approve it
  approveAction(dir, 's1', g.id, code);

  // Now try with check violation (--force push) → must still block on check
  const blocked = evaluateGate({ command: 'git push --force origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(blocked.kind, 'check', 'ask approval must NOT bypass checks - --force should block');
  assert.match(blocked.reason, /no force push/);
});

test('NEW-2: read-block and check-block decisions must carry userLine', () => {
  const dir = prepStateDir();
  const g = mkGuard();

  // Read block should have userLine
  const readBlock = evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(readBlock.kind, 'read');
  assert.ok(readBlock.userLine, 'read-block must have userLine');
  assert.match(readBlock.userLine, /blocked until the rule/);

  // Check block should have userLine
  evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' }); // consume read
  const checkBlock = evaluateGate({ command: 'docker compose build api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(checkBlock.kind, 'check');
  assert.ok(checkBlock.userLine, 'check-block must have userLine');
  assert.match(checkBlock.userLine, /blocked/);

  // Verify gate-log.jsonl still doesn't contain userLine text
  const logFile = path.join(dir, 'gate-log.jsonl');
  const logContent = fs.readFileSync(logFile, 'utf8');
  assert.ok(!logContent.includes('blocked until the rule'), 'gate-log must not contain userLine text');
  assert.ok(!logContent.includes('Approval code:'), 'gate-log must not contain userLine from ask');
});
