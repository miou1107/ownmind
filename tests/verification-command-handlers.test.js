/**
 * v1.19.20 — command_matches / command_not_matches handler tests
 *
 * Maps to openspec/changes/archive/v1.19.20-iron-rule-enforcement-finishing/.
 * Foundation for the five iron rules that compare Bash command strings against patterns.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { CHECK_HANDLERS, evaluateConditions } = await import('../shared/verification.js');

describe('command_matches — command must match at least one pattern', () => {
  const handler = CHECK_HANDLERS.command_matches;

  it('command contains pattern → pass', () => {
    const r = handler({ patterns: ['--no-cache'] }, { command: 'docker build --no-cache .' });
    assert.equal(r, true);
  });

  it('command does not contain pattern → fail', () => {
    const r = handler({ patterns: ['--no-cache'] }, { command: 'docker build .' });
    assert.equal(r, false);
  });

  it('multiple patterns, any match → pass', () => {
    const r = handler({ patterns: ['compose', 'buildx'] }, { command: 'docker compose build' });
    assert.equal(r, true);
  });

  it('multiple patterns, none match → fail', () => {
    const r = handler({ patterns: ['compose', 'buildx'] }, { command: 'docker build' });
    assert.equal(r, false);
  });

  it('context missing command → pass (skipped)', () => {
    const r = handler({ patterns: ['--no-cache'] }, {});
    assert.equal(r, true);
  });

  it('invalid regex → fail (conservative)', () => {
    const r = handler({ patterns: ['['] }, { command: 'docker build' });
    assert.equal(r, false);
  });

  it('regex is case-sensitive (default)', () => {
    const r = handler({ patterns: ['NOHUP'] }, { command: 'nohup npm install' });
    assert.equal(r, false);
  });

  it('regex word boundary matches correctly', () => {
    const r = handler({ patterns: ['\\bdocker\\s+build\\b'] }, { command: 'docker build .' });
    assert.equal(r, true);
  });

  it('regex word boundary avoids sub-string misfires', () => {
    const r = handler({ patterns: ['\\bdocker\\s+build\\b'] }, { command: 'mydocker buildx' });
    assert.equal(r, false);
  });
});

describe('command_not_matches — command must not match any pattern', () => {
  const handler = CHECK_HANDLERS.command_not_matches;

  it('command does not contain pattern → pass', () => {
    const r = handler({ patterns: ['sshpass'] }, { command: 'ssh user@host' });
    assert.equal(r, true);
  });

  it('command contains pattern → fail (violation)', () => {
    const r = handler({ patterns: ['sshpass'] }, { command: 'sshpass -p xxx ssh user@host' });
    assert.equal(r, false);
  });

  it('multiple patterns, any match → fail', () => {
    const r = handler({ patterns: ['sshpass', 'sslpass'] }, { command: 'sshpass -p xxx ssh user@host' });
    assert.equal(r, false);
  });

  it('multiple patterns, none match → pass', () => {
    const r = handler({ patterns: ['sshpass', 'sslpass'] }, { command: 'ssh user@host' });
    assert.equal(r, true);
  });

  it('context missing command → pass', () => {
    const r = handler({ patterns: ['sshpass'] }, {});
    assert.equal(r, true);
  });

  it('invalid regex → pass (not treated as violation)', () => {
    const r = handler({ patterns: ['['] }, { command: 'docker build' });
    assert.equal(r, true);
  });
});

describe('iron rule IR-018 docker build must use --no-cache (when/then composition)', () => {
  const cond = {
    when: { type: 'command_matches', params: { patterns: ['docker( compose)?\\s+build'] } },
    then: { type: 'command_matches', params: { patterns: ['--no-cache'] } },
  };

  it('docker build with --no-cache → pass', () => {
    const r = evaluateConditions(cond, { command: 'docker build --no-cache .' });
    assert.equal(r.pass, true);
  });

  it('docker build without --no-cache → fail', () => {
    const r = evaluateConditions(cond, { command: 'docker build .' });
    assert.equal(r.pass, false);
  });

  it('docker compose build with --no-cache → pass', () => {
    const r = evaluateConditions(cond, { command: 'docker compose build --no-cache api' });
    assert.equal(r.pass, true);
  });

  it('docker compose build without --no-cache → fail', () => {
    const r = evaluateConditions(cond, { command: 'docker compose build api' });
    assert.equal(r.pass, false);
  });

  it('non-docker-build commands → pass (when does not match, condition not applicable)', () => {
    const r = evaluateConditions(cond, { command: 'npm install' });
    assert.equal(r.pass, true);
  });
});

describe('iron rule IR-023 deploys must use docker compose build (when/then)', () => {
  const cond = {
    when: { type: 'command_matches', params: { patterns: ['\\bdocker\\s+build\\b'] } },
    then: { type: 'command_matches', params: { patterns: ['compose'] } },
  };

  it('docker compose build → pass', () => {
    const r = evaluateConditions(cond, { command: 'docker compose build api' });
    assert.equal(r.pass, true);
  });

  it('plain docker build → fail', () => {
    const r = evaluateConditions(cond, { command: 'docker build api' });
    assert.equal(r.pass, false);
  });
});

describe('iron rule IR-043 must not use sshpass', () => {
  const cond = { type: 'command_not_matches', params: { patterns: ['\\bsshpass\\b'] } };

  it('ssh without sshpass → pass', () => {
    const r = evaluateConditions(cond, { command: 'ssh root@host echo hi' });
    assert.equal(r.pass, true);
  });

  it('sshpass present → fail', () => {
    const r = evaluateConditions(cond, { command: 'sshpass -p xxx ssh root@host' });
    assert.equal(r.pass, false);
  });
});

describe('iron rule IR-046 long-running commands must use nohup (when/then)', () => {
  const cond = {
    when: {
      type: 'command_matches',
      params: { patterns: ['(docker( compose)?\\s+build|npm\\s+install|cargo\\s+build|mvn\\s+package|gradle\\s+build)'] },
    },
    then: { type: 'command_matches', params: { patterns: ['nohup'] } },
  };

  it('docker build with nohup → pass', () => {
    const r = evaluateConditions(cond, { command: 'nohup docker build --no-cache . &' });
    assert.equal(r.pass, true);
  });

  it('docker build without nohup → fail', () => {
    const r = evaluateConditions(cond, { command: 'docker build --no-cache .' });
    assert.equal(r.pass, false);
  });

  it('short command (ls) → pass (when not applicable)', () => {
    const r = evaluateConditions(cond, { command: 'ls -la' });
    assert.equal(r.pass, true);
  });
});
