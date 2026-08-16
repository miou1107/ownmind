/**
 * Tests for action gate guard matching.
 */

import { strict as assert } from 'assert';
import { test, beforeEach, afterEach } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { matchGuards, evaluateGate, approveAction, approveActionVerbal } from '../hooks/lib/action-gate.js';
import { ensureKey, ensureNonce } from '../hooks/lib/gate-receipt.js';
import { tempDir } from './helpers/temp-dir.js';

// Task 3 (gate-message-i18n) wired userLine through t(), which several assertions below pin
// as literal English text (e.g. the exact VERBAL go-ahead line, /tried to act without reading this rule first/).
// This suite predates locale support and is meant to pin BEHAVIOR, not translated copy, so it
// forces the locale rather than weakening those assertions — see tests/action-gate-i18n.test.js
// for the suite that actually exercises zh output and the en regression pin.
const ORIGINAL_LOCALE_FORCE = process.env.OWNMIND_LOCALE_FORCE;
beforeEach(() => { process.env.OWNMIND_LOCALE_FORCE = 'en'; });
afterEach(() => {
  if (ORIGINAL_LOCALE_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_LOCALE_FORCE;
});

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

/**
 * Issue a real ask for (session, guard), and hand back its code if it has one.
 *
 * These records used to be written by hand in the tests below. They cannot be any more, and
 * that is the point: an ask now carries a seal, and the gate ignores any approval it did not
 * issue itself. A fabricated record would exercise a path the product deliberately no longer
 * has — it would be testing the hole.
 *
 * @returns {{code: string|undefined}}
 */
function seedAsk(dir, sessionId, { id, mode = 'verbal' }) {
  const guard = mkGuard({
    id, ask_first: true, checks: [], read_required: false,
    ...(mode === 'verbal' && { ask_mode: 'verbal' }),
  });
  const ask = evaluateGate({
    command: 'git push origin ima-v9.9.9', guards: [guard], stateDir: dir, sessionId,
  });
  assert.equal(ask.kind, 'ask', `seedAsk did not produce an ask for guard ${id}`);
  return { code: (ask.userLine.match(/(\d{6})/) || [])[1] };
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
  assert.ok(!logContent.includes('OwnMind allows it this once'), 'userLine text must not appear in log');

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
  assert.match(readBlock.userLine, /tried to act without reading this rule first/);

  // Check block should have userLine
  evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' }); // consume read
  const checkBlock = evaluateGate({ command: 'docker compose build api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(checkBlock.kind, 'check');
  assert.ok(checkBlock.userLine, 'check-block must have userLine');
  assert.match(checkBlock.userLine, /does not meet your rules/);

  // Verify gate-log.jsonl still doesn't contain userLine text
  const logFile = path.join(dir, 'gate-log.jsonl');
  const logContent = fs.readFileSync(logFile, 'utf8');
  assert.ok(!logContent.includes('tried to act without reading this rule first'), 'gate-log must not contain userLine text');
  assert.ok(!logContent.includes('OwnMind allows it this once'), 'gate-log must not contain userLine from ask');
});

// --- CONSENT red-team (Task 9 § B) ---

test('CONSENT: the model-facing reason never carries the approval code (ask and limit)', () => {
  const dir = prepStateDir();

  // An ask_first guard issues an ask on first contact.
  const gAsk = mkGuard({ id: 700, ask_first: true, checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [gAsk], stateDir: dir, sessionId: 's1' });
  assert.equal(ask.kind, 'ask');
  const askCode = ask.userLine.match(/(\d{6})/)[1];
  assert.ok(!/\d{6}/.test(ask.reason), 'the ask reason must carry no 6-digit code');

  // A separate guard drops into stop-and-ask (limit) after three consecutive check blocks.
  const gLimit = mkGuard({ id: 701, read_required: false });
  for (let i = 0; i < 3; i += 1) {
    evaluateGate({ command: 'docker build .', guards: [gLimit], stateDir: dir, sessionId: 's1' });
  }
  const limit = evaluateGate({ command: 'docker build .', guards: [gLimit], stateDir: dir, sessionId: 's1' });
  assert.equal(limit.kind, 'limit');
  const limitCode = limit.userLine.match(/(\d{6})/)[1];
  assert.ok(!/\d{6}/.test(limit.reason), 'the limit reason must carry no 6-digit code');

  // Neither code is ever written to the audit log.
  const logContent = fs.readFileSync(path.join(dir, 'gate-log.jsonl'), 'utf8');
  assert.ok(!logContent.includes(askCode), 'the ask code must not appear in gate-log.jsonl');
  assert.ok(!logContent.includes(limitCode), 'the limit code must not appear in gate-log.jsonl');
});

test('code guessing burns the ask instead of yielding', () => {
  const dir = prepStateDir();
  const { code } = seedAsk(dir, 's1', { id: 918, mode: 'code' });
  for (let i = 0; i < 5; i += 1) assert.equal(approveAction(dir, 's1', 918, '000000'), false);
  assert.equal(approveAction(dir, 's1', 918, code), false, 'a burned ask never approves');
});

test('a fresh ask resets the burn counter so a legitimate code still approves', () => {
  const dir = prepStateDir();
  const g = mkGuard({ ask_first: true, checks: [], read_required: false });

  // Burn the first ask with five wrong guesses.
  const first = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(first.kind, 'ask');
  for (let i = 0; i < 5; i += 1) assert.equal(approveAction(dir, 's1', g.id, '000000'), false);

  // The next real gate evaluation issues a fresh ask (new code, counter reset).
  const second = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(second.kind, 'ask');
  const code = second.userLine.match(/(\d{6})/)[1];
  assert.equal(approveAction(dir, 's1', g.id, code), true, 'a fresh ask accepts the correct code again');
});

// --- Deferred hardening: gate-log rotation (Task 9 § C4, Task 6 review "Important") ---

test('gate-log rotates to .old past 5MB and the current log continues', () => {
  const dir = prepStateDir();
  const logFile = path.join(dir, 'gate-log.jsonl');
  // Pre-seed the log above the 5MB cap; the next write must rotate before appending.
  fs.writeFileSync(logFile, 'x'.repeat(5 * 1024 * 1024 + 16));

  // An allow logs exactly one line.
  const r = evaluateGate({ command: 'ls -la', guards: [], stateDir: dir, sessionId: 's1' });
  assert.equal(r.action, 'allow');

  assert.ok(fs.existsSync(logFile + '.old'), 'the oversized log rotates to gate-log.jsonl.old');
  const cur = fs.readFileSync(logFile, 'utf8');
  assert.ok(cur.length < 5 * 1024 * 1024, 'the current log restarts small after rotation');
  assert.match(cur, /"action":"allow"/, 'the new entry lands in the fresh current log');
});

// --- Deferred hardening: applies_pattern case-insensitivity (Task 9 § C5) ---

test('a capital-G "Git push" version-tag deploy is still gated', () => {
  // The shared trigger classifier is /i, so a bare-trigger guard already catches capital G.
  assert.equal(
    matchGuards('Git push origin v1.2.9', [DEPLOY_GUARD]).length, 1,
    'the /i classifier catches capital-G git push for a bare-trigger guard'
  );

  // A guard that scopes itself with applies_pattern uses its own regex; it must match
  // case-insensitively too, or a capitalized command walks past a rule that scoped itself.
  const scoped = {
    id: 137, kind: 'action', title: 'tag push (scoped)', triggers: ['deploy'],
    applies_pattern: 'git\\s+push\\b.*\\s(refs\\/tags\\/)?(v\\d|ima-v|ima-rc)',
    checks: [], read_required: true, ask_first: false, rule_text: 'x', rules_hash: 'h',
  };
  assert.equal(
    matchGuards('Git push origin v1.2.9', [scoped]).length, 1,
    'a pattern-scoped guard must match case-insensitively too'
  );
});

// --- Amendment 3: verbal approval mode ---

test('VERBAL: a verbal ask blocks with a go-ahead line, carries no code, and never claims approval', () => {
  const dir = prepStateDir();
  const g = mkGuard({ ask_first: true, ask_mode: 'verbal', checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(ask.kind, 'ask');
  assert.equal(ask.action, 'block', 'a verbal ask still blocks');
  // The exact go-ahead line Amendment 3 specifies.
  assert.equal(
    ask.userLine,
    '[OwnMind] 🟢 The AI wants to do something your rules say to ask about first, so OwnMind stopped it: compose no-cache\n'
    + '  Reply "go" and OwnMind allows it this once; reply "no" and it does not.',
  );
  // No secret code anywhere: verbal mode issues none.
  assert.ok(!/\d{6}/.test(ask.userLine), 'a verbal ask must carry no 6-digit code in the user line');
  assert.ok(!/\d{6}/.test(ask.reason), 'a verbal ask must carry no 6-digit code in the reason');
  // The reason must instruct the --verbal CLI and must NOT claim the user already approved.
  assert.match(ask.reason, /approve-action\.js --verbal 918/, 'the reason must point at the --verbal CLI');
  assert.ok(!/already approved|has approved|user approved this/i.test(ask.reason),
    'the reason must not claim the user already approved');
});

test('VERBAL: approveActionVerbal approves a verbal ask once, then it is one-shot', () => {
  const dir = prepStateDir();
  const g = mkGuard({ id: 819, ask_first: true, ask_mode: 'verbal', checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(ask.kind, 'ask');
  assert.equal(approveActionVerbal(dir, 's1', g.id), true, 'a verbal approve marks the ask approved');
  const allowed = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(allowed.action, 'allow', 'the retry after a verbal go is allowed once');
  const again = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(again.kind, 'ask', 'the verbal approval is one-shot');
});

test('VERBAL SECURITY: a verbal approve cannot satisfy a code-mode ask', () => {
  const dir = prepStateDir();
  const g = mkGuard({ id: 820, ask_first: true, checks: [], read_required: false }); // default ask_mode: code
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(ask.kind, 'ask');
  assert.ok(/\d{6}/.test(ask.userLine), 'a code-mode ask still issues a 6-digit code');
  // The verbal CLI must NOT be able to downgrade a code guard to a codeless go-ahead.
  assert.equal(approveActionVerbal(dir, 's1', g.id), false, 'a verbal approve must refuse a code-mode ask');
  // The guard is still blocked (no approval was recorded).
  const still = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(still.kind, 'ask', 'the code-mode ask is still pending after a rejected verbal approve');
});

test('VERBAL SECURITY: a code approve cannot satisfy a verbal ask', () => {
  const dir = prepStateDir();
  const g = mkGuard({ id: 821, ask_first: true, ask_mode: 'verbal', checks: [], read_required: false });
  evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  // A verbal ask carries no code; the code CLI must not approve it with any guess.
  assert.equal(approveAction(dir, 's1', g.id, '000000'), false, 'a code approve must refuse a verbal ask');
  assert.equal(approveAction(dir, 's1', g.id, '123456'), false, 'still refused for any code');
  // A legitimate verbal approve still works after the code attempts.
  assert.equal(approveActionVerbal(dir, 's1', g.id), true, 'the verbal approve still works');
});

test('VERBAL: approveActionVerbal refuses a bad sessionId and a non-positive guardId', () => {
  const dir = prepStateDir();
  const g = mkGuard({ id: 822, ask_first: true, ask_mode: 'verbal', checks: [], read_required: false });
  evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(approveActionVerbal(dir, '../etc/passwd', g.id), false, 'path-traversal sessionId is refused');
  assert.equal(approveActionVerbal(dir, 's1', -1), false, 'negative guardId is refused');
  assert.equal(approveActionVerbal(dir, 's1', 0), false, 'zero guardId is refused');
  assert.equal(approveActionVerbal(dir, 's1', 'not-a-number'), false, 'non-integer guardId is refused');
});

test('VERBAL: gate-log records approval_mode verbal on issue and on the approved allow, never a code', () => {
  const dir = prepStateDir();
  const g = mkGuard({ id: 823, ask_first: true, ask_mode: 'verbal', checks: [], read_required: false });

  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(ask.kind, 'ask');
  approveActionVerbal(dir, 's1', g.id);
  const allowed = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(allowed.action, 'allow');

  const entries = fs.readFileSync(path.join(dir, 'gate-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const askEntry = entries.find((e) => e.kind === 'ask');
  assert.equal(askEntry.approval_mode, 'verbal', 'the verbal ask block logs approval_mode: verbal');
  assert.ok(!('code_issued' in askEntry), 'a verbal ask logs no code_issued flag');
  const allowEntry = entries.find((e) => e.action === 'allow');
  assert.equal(allowEntry.approval_mode, 'verbal', 'the allow that consumes a verbal go logs approval_mode: verbal');
  // No 6-digit code is ever written for a verbal flow.
  assert.ok(!/\d{6}/.test(fs.readFileSync(path.join(dir, 'gate-log.jsonl'), 'utf8')),
    'the gate-log carries no code for a verbal flow');
});

// --- CLI: approve-action ---

test('the approval CLI approves a verbal ask via --verbal, and refuses a code-mode ask', () => {
  const dir = prepStateDir();
  fs.writeFileSync(path.join(dir, 'gate-current-session'), 's1');
  // A verbal ask carries no stored code, only mode: 'verbal'.
  seedAsk(dir, 's1', { id: 830 });
  const env = { ...process.env, OWNMIND_GATE_STATE_DIR: dir };
  const ok = spawnSync('node', ['hooks/lib/approve-action.js', '--verbal', '830'], { encoding: 'utf8', env });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /APPROVED/);
  // One-shot: the second --verbal is rejected (already approved).
  const again = spawnSync('node', ['hooks/lib/approve-action.js', '--verbal', '830'], { encoding: 'utf8', env });
  assert.equal(again.status, 1);
  assert.match(again.stdout, /REJECTED/);

  // A code-mode ask must not be approvable via --verbal.
  seedAsk(dir, 's1', { id: 831, mode: 'code' });
  const rejected = spawnSync('node', ['hooks/lib/approve-action.js', '--verbal', '831'], { encoding: 'utf8', env });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /REJECTED/);
});

test('the approval CLI approves the session it is given, not whichever started last', () => {
  // v1.26.174. The gate writes its ask under the session it blocked; this CLI used to look
  // the session up in `gate-current-session`, a single pointer every SessionStart overwrites.
  // Measured on the first real release this gate stopped: the ask belonged to the blocked
  // session, the pointer belonged to a second Claude session started minutes later, and a
  // genuine user "go" printed REJECTED. Two sessions open — the normal state on this
  // author's machine — meant the gate could not be approved at all.
  const dir = prepStateDir();
  // The pointer names the OTHER session, exactly as a later SessionStart would leave it.
  fs.writeFileSync(path.join(dir, 'gate-current-session'), 'other-session');
  seedAsk(dir, 'blocked-session', { id: 820 });
  const env = { ...process.env, OWNMIND_GATE_STATE_DIR: dir };

  // Without the flag the CLI resolves the pointer, finds no ask there, and refuses. That is
  // the defect, pinned: it is what the old code did on every invocation.
  const blind = spawnSync('node', ['hooks/lib/approve-action.js', '--verbal', '820'], { encoding: 'utf8', env });
  assert.equal(blind.status, 1, 'the pointer names a session with no such ask, so this must refuse');

  const named = spawnSync('node',
    ['hooks/lib/approve-action.js', '--verbal', '820', '--session', 'blocked-session'],
    { encoding: 'utf8', env });
  assert.equal(named.status, 0, `naming the blocked session must approve it; got ${named.stdout}${named.stderr}`);
  assert.match(named.stdout, /APPROVED/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'gate-ask-blocked-session-820.json'), 'utf8')).approved, true);

  // The pointer's own session is untouched — this names a session, it does not claim one.
  assert.equal(fs.readFileSync(path.join(dir, 'gate-current-session'), 'utf8'), 'other-session');

  // Still one-shot, and the flag order does not matter for the code form either.
  const twice = spawnSync('node',
    ['hooks/lib/approve-action.js', '--verbal', '820', '--session', 'blocked-session'],
    { encoding: 'utf8', env });
  assert.equal(twice.status, 1, 'an already-approved ask must still refuse a second time');

  // A code-mode ask in a named session takes the code path and nothing else.
  const { code: code821 } = seedAsk(dir, 'blocked-session', { id: 821, mode: 'code' });
  const wrongCode = spawnSync('node',
    ['hooks/lib/approve-action.js', '821', '000000', '--session', 'blocked-session'], { encoding: 'utf8', env });
  assert.equal(wrongCode.status, 1, 'naming a session must not let a wrong code through');
  const rightCode = spawnSync('node',
    ['hooks/lib/approve-action.js', '821', code821, '--session', 'blocked-session'], { encoding: 'utf8', env });
  assert.equal(rightCode.status, 0, `the real code in a named session must approve; got ${rightCode.stdout}`);
  // And --verbal still cannot downgrade a code-mode ask, named session or not.
  seedAsk(dir, 'blocked-session', { id: 822, mode: 'code' });
  const downgrade = spawnSync('node',
    ['hooks/lib/approve-action.js', '--verbal', '822', '--session', 'blocked-session'], { encoding: 'utf8', env });
  assert.equal(downgrade.status, 1, '--session must not become a way around code mode');

  // v1.30.1: an unsafe id is refused at the CLI, not passed down to be coerced.
  //
  // The first version of this assertion used '../../blocked-session' and called itself a
  // traversal test. It was neither: path.join normalises that to <dir>/blocked-session-820.json,
  // which does not exist, so it was green with or without any validation. Worse, the property
  // it claimed — "an unsafe id is refused" — was false: action-gate.js *collapses* an unsafe id
  // to the literal 'unknown', a bucket every session with no usable id shares, so a malformed
  // --session did not fail, it landed on somebody else's record. Proven here by seeding that
  // bucket and showing the malformed forms cannot reach it.
  seedAsk(dir, 'unknown', { id: 830 });
  for (const bad of ['../../blocked-session', 'has space', 'a/b', '', 'x\ny']) {
    const res = spawnSync('node',
      ['hooks/lib/approve-action.js', '--verbal', '830', '--session', bad], { encoding: 'utf8', env });
    assert.equal(res.status, 1, `an unsafe session id must be refused: ${JSON.stringify(bad)}`);
    assert.match(res.stdout, /REJECTED/);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'gate-ask-unknown-830.json'), 'utf8')).approved,
    false, "no malformed id may reach the shared 'unknown' bucket");

  // A flag that was passed must be honoured or refused, never silently ignored: falling back
  // to the pointer here would reinstate the bug --session exists to fix.
  fs.writeFileSync(path.join(dir, 'gate-current-session'), 'blocked-session');
  seedAsk(dir, 'blocked-session', { id: 831 });
  const noValue = spawnSync('node',
    ['hooks/lib/approve-action.js', '--verbal', '831', '--session'], { encoding: 'utf8', env });
  assert.equal(noValue.status, 1, '--session with no value must refuse, not fall back to the pointer');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'gate-ask-blocked-session-831.json'), 'utf8')).approved,
    false, 'and it must not have approved through the pointer either');

  // Every refusal now says why on stderr. stdout keeps its one-word contract.
  assert.match(noValue.stderr, /--session was given with no value/);
  assert.equal(noValue.stdout.trim(), 'REJECTED', 'stdout stays parseable');
});

test('the gate names the blocked session in the approval command it hands the AI', () => {
  // The CLI's --session flag is only reachable if the instruction carries the value, and the
  // AI has no other way to learn its own session id — it is in no environment variable.
  const dir = prepStateDir();
  const verbalGuard = mkGuard({ id: 820, ask_first: true, ask_mode: 'verbal', checks: [], read_required: false });
  const verbal = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [verbalGuard], stateDir: dir, sessionId: 'sess-abc' });
  assert.equal(verbal.kind, 'ask');
  assert.match(verbal.reason, /--verbal 820 --session sess-abc/,
    'the verbal instruction must name the blocked session');

  const codeGuard = mkGuard({ id: 821, ask_first: true, checks: [], read_required: false });
  const coded = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [codeGuard], stateDir: dir, sessionId: 'sess-abc' });
  assert.equal(coded.kind, 'ask');
  assert.match(coded.reason, /approve-action\.js 821 <code> --session sess-abc/,
    'the code instruction must name it too');
});

test('the approval CLI approves a valid code once', () => {
  const dir = prepStateDir();
  fs.writeFileSync(path.join(dir, 'gate-current-session'), 's1');
  const { code } = seedAsk(dir, 's1', { id: 918, mode: 'code' });
  const env = { ...process.env, OWNMIND_GATE_STATE_DIR: dir };
  const ok = spawnSync('node', ['hooks/lib/approve-action.js', '918', code], { encoding: 'utf8', env });
  assert.equal(ok.status, 0); assert.match(ok.stdout, /APPROVED/);
  const again = spawnSync('node', ['hooks/lib/approve-action.js', '918', code], { encoding: 'utf8', env });
  assert.equal(again.status, 1);
});
