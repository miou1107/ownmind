import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { detectCommandTrigger } from '../shared/helpers.js';

/**
 * issue #92 — the two command classifiers must answer the same thing.
 *
 * `ownmind-iron-rule-check` ships twice: the `.js` hook classifies through
 * `detectCommandTrigger()` in shared/helpers.js, and the `.sh` hook rebuilds the same
 * decision as a hand-written `grep -qiE` chain. Both exist for good reasons — the shell copy
 * needs no node on PATH and avoids handing node a path, the move behind two silent Windows
 * failures (v1.26.88, v1.26.90).
 *
 * What did not exist was anything holding them to the same answers. The KEEP IN SYNC note in
 * shared/helpers.js covers `TRIGGER_TAG_ALIASES` only, and the drift test beside it compares
 * that one table. The classification itself was unguarded, and `install.sh` registers the
 * `.sh` copy on mac and Linux — so the unguarded implementation is the one actually running
 * for most users.
 *
 * Measured before this test existed: 7 of the 17 commands below were classified differently.
 * `git tag` reached no trigger at all on mac/Linux, so a release tag — the moment a commit
 * rule most wants to speak — was silent. `docker compose build` and `docker compose push`
 * likewise. In the other direction `docker.*up` matched `docker logs backup` and
 * `docker ps | grep uptime`, because `backup` and `uptime` both contain "up": reading a log
 * produced a full deployment rule listing.
 *
 * `shared/helpers.js` is the reference. It is the copy the KEEP IN SYNC note names, the copy
 * carrying the per-pattern rationale, and the copy already under test.
 *
 * The shell side is observed by running the real hook, never by restating its grep chain
 * here. A third copy of the logic would be the defect this file exists to catch, written into
 * the thing catching it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/**
 * The commands both copies must agree on, and the answer shared/helpers.js gives.
 *
 * Every row is here because it separates the two implementations or pins a boundary one of
 * them got wrong. `expected` is deliberately written out rather than derived from
 * `detectCommandTrigger`: a table that asks the reference what it thinks would keep agreeing
 * with itself after someone edits the reference by accident.
 */
const COMMANDS = [
  { command: 'git commit -m "x"', expected: 'commit' },
  // Absent from the shell chain until issue #92. Tagging a release is a commit-family
  // operation and the version-sync rules are written for exactly this moment.
  { command: 'git tag v1.2.3', expected: 'commit' },
  { command: 'git push origin main --tags', expected: 'deploy' },
  // `docker.*up` covered neither of these, so a rule saying "deploy with docker compose
  // build" stayed silent during `docker compose build`.
  { command: 'docker compose build', expected: 'deploy' },
  { command: 'docker compose push web', expected: 'deploy' },
  { command: 'docker compose up -d', expected: 'deploy' },
  // The other direction: `up` inside `backup` and `uptime` is not a deployment.
  { command: 'docker logs backup', expected: null },
  { command: 'docker ps | grep uptime', expected: null },
  // The one the shell chain recognised and the reference did not. Squaring them added it to
  // the reference rather than dropping it: a Swarm deploy is a deploy.
  { command: 'docker stack deploy -c stack.yml web', expected: 'deploy' },
  { command: 'kubectl apply -f k8s.yaml', expected: 'deploy' },
  { command: 'rm -rf ./dist', expected: 'delete' },
  { command: 'Remove-Item -Recurse ./dist', expected: 'delete' },
  { command: 'psql -c "DELETE FROM users"', expected: 'delete' },
  // Both families match. The reference tests deploy first, so a command that deploys and
  // then tidies up is a deploy; the shell chain tested delete first and disagreed.
  { command: 'docker compose up -d && rm -rf ./old', expected: 'deploy' },
  { command: 'bash install.sh --api-key abc', expected: 'install' },
  { command: 'curl -H "X-API-KEY: k" https://x/api', expected: 'install' },
  // A dependency install is not an install: a reminder in front of every `npm install` is
  // one the user learns to scroll past.
  { command: 'npm install', expected: null },
  { command: 'echo hello', expected: null },
];

/**
 * One rule tagged `trigger:command`, which `ruleMatchesTrigger` accepts for every trigger.
 *
 * That is what makes the shell hook observable: whatever trigger it picked, a rule matches,
 * so it prints its banner and the banner names the trigger. A rule tagged for one trigger
 * would leave the others silent and every silence would read as "classified as nothing".
 */
const RULES_RESPONSE = {
  data: [{ code: 'IR-PARITY', title: 'a rule relevant to every trigger', tags: ['trigger:command'] }],
};

/**
 * Read the trigger back out of the hook's own output.
 *
 * Two banner shapes exist (`ownmind-iron-rule-check.sh:271-281`): commit gets the short form,
 * everything else gets `鐵律觸發（<trigger>）`. Empty output means no trigger was detected.
 *
 * Output that is neither empty nor recognisable throws instead of returning null. A renamed
 * banner would otherwise turn every command into "classified as nothing" and the whole file
 * would pass while measuring the wrong thing.
 */
function triggerFromHookOutput(stdout) {
  const named = stdout.match(/鐵律觸發（([a-z_]+)）/);
  if (named) return named[1];
  if (/鐵律檢查：commit 操作/.test(stdout)) return 'commit';
  if (stdout.trim() === '') return null;
  throw new Error(`the shell hook printed something this test cannot read:\n${stdout.slice(0, 400)}`);
}

describe('issue #92 — the .js and .sh command classifiers agree', () => {
  describe('shared/helpers.js — the reference', () => {
    for (const { command, expected } of COMMANDS) {
      it(`${command} → ${expected}`, () => {
        assert.equal(detectCommandTrigger(command), expected);
      });
    }
  });

  describe('hooks/ownmind-iron-rule-check.sh — the copy that runs on mac and Linux', () => {
    let server;
    let baseUrl;
    let tmpHome;

    before(async () => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(RULES_RESPONSE));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${server.address().port}`;

      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-trigger-parity-'));
      fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpHome, '.claude', 'settings.json'),
        JSON.stringify({
          mcpServers: {
            ownmind: { env: { OWNMIND_API_KEY: 'test-key', OWNMIND_API_URL: baseUrl } },
          },
        })
      );
      // No ~/.ownmind/.git: that keeps the one-time upgrade block, which runs `git pull`,
      // from firing inside a test run.
      fs.mkdirSync(path.join(tmpHome, '.ownmind', 'hooks'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpHome, '.ownmind', 'package.json'),
        JSON.stringify({ version: '99.99.99' })
      );
      fs.symlinkSync(path.join(repoRoot, 'shared'), path.join(tmpHome, '.ownmind', 'shared'));
      fs.symlinkSync(
        path.join(repoRoot, 'hooks', 'ownmind-verify-trigger.js'),
        path.join(tmpHome, '.ownmind', 'hooks', 'ownmind-verify-trigger.js')
      );
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    /** Run the real hook with one command and report what it classified it as. */
    function classify(command) {
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
        child.on('close', (status) => resolve({ status, stdout, stderr }));
        child.stdin.end(JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
        }));
      });
    }

    for (const { command, expected } of COMMANDS) {
      // Spawned unconditionally, as tests/iron-rule-install-trigger.test.js already does. A
      // `bash is missing` skip would turn the whole half of this file that guards the drifting
      // copy into a green no-op on any machine that happened not to resolve it.
      it(`${command} → ${expected}`, async () => {
        const r = await classify(command);
        assert.equal(r.status, 0,
          `a hook must never fail the tool call it inspects. stderr=${r.stderr.slice(0, 300)}`);
        assert.equal(triggerFromHookOutput(r.stdout), expected,
          'the shell copy disagrees with shared/helpers.js — see the KEEP IN SYNC note there');
      });
    }
  });
});
