/**
 * Tests for action gate guard matching.
 */

import { strict as assert } from 'assert';
import { test } from 'node:test';
import { matchGuards } from '../hooks/lib/action-gate.js';

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
