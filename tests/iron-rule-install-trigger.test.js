import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stageHookHome } from './helpers/hook-home.js';

import {
  detectCommandTrigger,
  detectTriggerFromContext,
  ruleMatchesTrigger,
  TRIGGER_TAG_ALIASES,
} from '../shared/helpers.js';

/**
 * v1.26.132 — the two rules that exist to catch a bad install could never fire during one.
 *
 * The trigger gate recognised four command shapes: git commit/reset/rebase/merge, git push,
 * rm/rmdir/drop, and the deploy family. Nothing else reached the rule lookup at all.
 *
 * Measured on this account 2026-08-10, where all four rules were tagged by their author:
 *
 *   IR-001  換金鑰／切換帳號後，必須自己開設定檔確認值真的變了   trigger:install setup config api_key
 *   IR-002  set -e 腳本裡的 2>/dev/null 是紅旗                     trigger:install script shell debug
 *   IR-003  失敗處理不能毀掉診斷線索                               trigger:cleanup 回滾 還原  → fires
 *   IR-004  回我話要用白話中文                                     trigger:reply language  (Stop hook)
 *
 * `bash install.sh --api-key <k>` produced no output whatsoever. So IR-001 — a rule whose
 * entire content is "the install script saying it succeeded does not count, go and verify" —
 * was silent during exactly the operation it names. The tags were not wrong; no trigger
 * accepted them.
 *
 * `npm install` is deliberately excluded below. A gate that fires on every dependency
 * install is a gate the user learns to scroll past, and the rules here are about
 * credentials and install scripts, not about fetching packages.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** Rules shaped like the ones this defect was measured against. */
const RULES_RESPONSE = {
  data: [
    {
      code: 'IR-001',
      title: '換金鑰／切換帳號後，必須自己開設定檔確認值真的變了',
      tags: ['trigger:換金鑰', 'trigger:install', 'trigger:setup', 'trigger:config', 'trigger:api_key'],
    },
    {
      code: 'IR-002',
      title: 'set -e 腳本裡的 2>/dev/null 是紅旗',
      tags: ['trigger:debug', 'trigger:shell', 'trigger:script', 'trigger:install'],
    },
    {
      code: 'IR-999',
      title: 'a rule about deleting things, which an install must not drag in',
      tags: ['trigger:delete'],
    },
  ],
};

describe('v1.26.132 — install and credential commands reach the rule lookup', () => {
  describe('detectCommandTrigger', () => {
    for (const command of [
      'bash install.sh',
      './install.sh --api-key abc123',
      'bash ~/.ownmind/scripts/update.sh',
      'bash setup.sh',
      'curl -H "Authorization: Bearer $API_KEY" https://example.com/api',
      'export OWNMIND_API_KEY=abc',
    ]) {
      it(`classifies as install: ${command}`, () => {
        assert.equal(detectCommandTrigger(command), 'install',
          'this is the operation IR-001 and IR-002 were written for');
      });
    }

    for (const command of [
      'npm install',
      'npm install --save-dev vitest',
      'pip install requests',
      'ls -la',
      'cat package.json',
    ]) {
      it(`does not classify as install: ${command}`, () => {
        assert.notEqual(detectCommandTrigger(command), 'install',
          'a gate that fires on every dependency install is one the user stops reading');
      });
    }

    it('leaves the existing triggers alone', () => {
      assert.equal(detectCommandTrigger('git commit -m x'), 'commit');
      assert.equal(detectCommandTrigger('git push origin main'), 'deploy');
      assert.equal(detectCommandTrigger('rm -rf /tmp/x'), 'delete');
    });
  });

  describe('detectTriggerFromContext — the same vocabulary one door further in', () => {
    // MCP report_compliance classifies free text through this. Leaving `install` out of it
    // would rebuild the mismatch this release closes, in the other entry point.
    for (const context of [
      'running install.sh on a new machine',
      '換金鑰之後要自己開設定檔確認',
      '切換帳號到測試帳號',
      '安裝完成後的驗證',
    ]) {
      it(`classifies as install: ${context}`, () => {
        assert.equal(detectTriggerFromContext(context), 'install');
      });
    }

    it('leaves the existing classifications alone', () => {
      assert.equal(detectTriggerFromContext('preparing to commit code'), 'commit');
      assert.equal(detectTriggerFromContext('準備部署到伺服器'), 'deploy');
      assert.equal(detectTriggerFromContext('準備刪除舊資料'), 'delete');
      assert.equal(detectTriggerFromContext('just reading a file'), null);
    });
  });

  describe('TRIGGER_TAG_ALIASES', () => {
    it('accepts the tags the rules actually carry', () => {
      assert.ok(TRIGGER_TAG_ALIASES.install, 'install must be a known trigger');
      for (const rule of RULES_RESPONSE.data.slice(0, 2)) {
        assert.equal(ruleMatchesTrigger(rule, 'install'), true,
          `${rule.code} is tagged for install and must be selected`);
      }
    });

    it('does not drag in rules tagged for other operations', () => {
      assert.equal(ruleMatchesTrigger(RULES_RESPONSE.data[2], 'install'), false,
        'a delete rule has nothing to say about running an install script');
    });
  });

  describe('the shell hook end to end', () => {
    let server;
    let baseUrl;
    let hits;
    let tmpHome;

    before(async () => {
      hits = [];
      server = http.createServer((req, res) => {
        hits.push(req.url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(RULES_RESPONSE));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${server.address().port}`;

      tmpHome = stageHookHome({ apiUrl: baseUrl });
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    /** Run the shell hook and report whether it looked the rules up. */
    function run(command) {
      const before = hits.length;
      return new Promise((resolve, reject) => {
        const child = spawn('bash', [path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.sh')], {
          cwd: repoRoot,
          env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
          stdio: 'pipe',
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('error', reject);
        child.on('close', (status) => {
          const reached = hits.slice(before).some((u) => u.includes('/api/memory/type/iron_rule'));
          resolve({ status, stdout, stderr, reached });
        });
        child.stdin.end(JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
        }));
      });
    }

    it('an install script reaches the rule lookup and names the rules', async () => {
      const r = await run('bash install.sh --api-key abc123');
      assert.equal(r.reached, true,
        `the install trigger never reached the API. exit=${r.status} stderr=${r.stderr.slice(0, 300)}`);
      assert.match(r.stdout, /IR-001/, 'the rule about verifying a key change must be named');
      assert.match(r.stdout, /IR-002/, 'the rule about silent script failure must be named');
      assert.doesNotMatch(r.stdout, /IR-999/, 'a delete rule must not appear during an install');
    });

    it('never blocks the command', async () => {
      const r = await run('bash install.sh --api-key abc123');
      assert.equal(r.status, 0, 'a hook must never fail the tool call it is inspecting');
      assert.doesNotMatch(r.stdout, /"decision"\s*:\s*"block"/, 'report, do not abort');
    });

    it('npm install stays silent', async () => {
      const r = await run('npm install');
      assert.equal(r.stdout.trim(), '', 'silence, not a reminder in front of every dependency install');
    });
  });
});
