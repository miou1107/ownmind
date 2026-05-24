/**
 * v1.19.20 — command_matches / command_not_matches handler 測試
 *
 * 對應 openspec/changes/archive/v1.19.20-iron-rule-enforcement-finishing/
 * 5 條鐵律的 Bash 指令字串樣式比對基礎。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { CHECK_HANDLERS, evaluateConditions } = await import('../shared/verification.js');

describe('command_matches — 指令必須符合任一樣式', () => {
  const handler = CHECK_HANDLERS.command_matches;

  it('command 含 pattern → pass', () => {
    const r = handler({ patterns: ['--no-cache'] }, { command: 'docker build --no-cache .' });
    assert.equal(r, true);
  });

  it('command 不含 pattern → fail', () => {
    const r = handler({ patterns: ['--no-cache'] }, { command: 'docker build .' });
    assert.equal(r, false);
  });

  it('多 pattern 任一命中 → pass', () => {
    const r = handler({ patterns: ['compose', 'buildx'] }, { command: 'docker compose build' });
    assert.equal(r, true);
  });

  it('多 pattern 都沒命中 → fail', () => {
    const r = handler({ patterns: ['compose', 'buildx'] }, { command: 'docker build' });
    assert.equal(r, false);
  });

  it('context 缺 command → pass（跳過）', () => {
    const r = handler({ patterns: ['--no-cache'] }, {});
    assert.equal(r, true);
  });

  it('無效 regex → fail（保守）', () => {
    const r = handler({ patterns: ['['] }, { command: 'docker build' });
    assert.equal(r, false);
  });

  it('regex 大小寫敏感（預設）', () => {
    const r = handler({ patterns: ['NOHUP'] }, { command: 'nohup npm install' });
    assert.equal(r, false);
  });

  it('regex word boundary 正確 match', () => {
    const r = handler({ patterns: ['\\bdocker\\s+build\\b'] }, { command: 'docker build .' });
    assert.equal(r, true);
  });

  it('regex word boundary 避開 sub-string 誤判', () => {
    const r = handler({ patterns: ['\\bdocker\\s+build\\b'] }, { command: 'mydocker buildx' });
    assert.equal(r, false);
  });
});

describe('command_not_matches — 指令不能含任何樣式', () => {
  const handler = CHECK_HANDLERS.command_not_matches;

  it('command 不含 pattern → pass', () => {
    const r = handler({ patterns: ['sshpass'] }, { command: 'ssh user@host' });
    assert.equal(r, true);
  });

  it('command 含 pattern → fail（違反）', () => {
    const r = handler({ patterns: ['sshpass'] }, { command: 'sshpass -p xxx ssh user@host' });
    assert.equal(r, false);
  });

  it('多 pattern 任一命中 → fail', () => {
    const r = handler({ patterns: ['sshpass', 'sslpass'] }, { command: 'sshpass -p xxx ssh user@host' });
    assert.equal(r, false);
  });

  it('多 pattern 都沒命中 → pass', () => {
    const r = handler({ patterns: ['sshpass', 'sslpass'] }, { command: 'ssh user@host' });
    assert.equal(r, true);
  });

  it('context 缺 command → pass', () => {
    const r = handler({ patterns: ['sshpass'] }, {});
    assert.equal(r, true);
  });

  it('無效 regex → pass（不視為違反）', () => {
    const r = handler({ patterns: ['['] }, { command: 'docker build' });
    assert.equal(r, true);
  });
});

describe('鐵律 IR-018 docker build 必須 --no-cache（when/then 組合場景）', () => {
  const cond = {
    when: { type: 'command_matches', params: { patterns: ['docker( compose)?\\s+build'] } },
    then: { type: 'command_matches', params: { patterns: ['--no-cache'] } },
  };

  it('docker build 含 --no-cache → pass', () => {
    const r = evaluateConditions(cond, { command: 'docker build --no-cache .' });
    assert.equal(r.pass, true);
  });

  it('docker build 缺 --no-cache → fail', () => {
    const r = evaluateConditions(cond, { command: 'docker build .' });
    assert.equal(r.pass, false);
  });

  it('docker compose build 含 --no-cache → pass', () => {
    const r = evaluateConditions(cond, { command: 'docker compose build --no-cache api' });
    assert.equal(r.pass, true);
  });

  it('docker compose build 缺 --no-cache → fail', () => {
    const r = evaluateConditions(cond, { command: 'docker compose build api' });
    assert.equal(r.pass, false);
  });

  it('非 docker build 指令 → pass（when 不成立、條件不適用）', () => {
    const r = evaluateConditions(cond, { command: 'npm install' });
    assert.equal(r.pass, true);
  });
});

describe('鐵律 IR-023 部署用 docker compose build（when/then 場景）', () => {
  const cond = {
    when: { type: 'command_matches', params: { patterns: ['\\bdocker\\s+build\\b'] } },
    then: { type: 'command_matches', params: { patterns: ['compose'] } },
  };

  it('docker compose build → pass', () => {
    const r = evaluateConditions(cond, { command: 'docker compose build api' });
    assert.equal(r.pass, true);
  });

  it('docker build → fail', () => {
    const r = evaluateConditions(cond, { command: 'docker build api' });
    assert.equal(r.pass, false);
  });
});

describe('鐵律 IR-043 不能用 sshpass', () => {
  const cond = { type: 'command_not_matches', params: { patterns: ['\\bsshpass\\b'] } };

  it('ssh 沒 sshpass → pass', () => {
    const r = evaluateConditions(cond, { command: 'ssh root@host echo hi' });
    assert.equal(r.pass, true);
  });

  it('sshpass → fail', () => {
    const r = evaluateConditions(cond, { command: 'sshpass -p xxx ssh root@host' });
    assert.equal(r.pass, false);
  });
});

describe('鐵律 IR-046 長指令必須加 nohup（when/then 場景）', () => {
  const cond = {
    when: {
      type: 'command_matches',
      params: { patterns: ['(docker( compose)?\\s+build|npm\\s+install|cargo\\s+build|mvn\\s+package|gradle\\s+build)'] },
    },
    then: { type: 'command_matches', params: { patterns: ['nohup'] } },
  };

  it('docker build 含 nohup → pass', () => {
    const r = evaluateConditions(cond, { command: 'nohup docker build --no-cache . &' });
    assert.equal(r.pass, true);
  });

  it('docker build 沒 nohup → fail', () => {
    const r = evaluateConditions(cond, { command: 'docker build --no-cache .' });
    assert.equal(r.pass, false);
  });

  it('短指令（ls） → pass（when 不適用）', () => {
    const r = evaluateConditions(cond, { command: 'ls -la' });
    assert.equal(r.pass, true);
  });
});
