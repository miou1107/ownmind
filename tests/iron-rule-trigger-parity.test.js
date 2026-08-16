import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { detectCommandTrigger } from '../shared/helpers.js';
import { stageHookHome } from './helpers/hook-home.js';

/**
 * issue #92 — both routes into the classifier must answer the same thing.
 *
 * `ownmind-iron-rule-check` ships twice. The `.js` hook imports `detectCommandTrigger()`
 * from shared/helpers.js; the `.sh` hook pipes the command into
 * hooks/ownmind-detect-trigger.js, which wraps the same function. One implementation, two
 * ways in — so what this file now guards is the plumbing, not a second rule list.
 *
 * It did not start there. The `.sh` hook used to rebuild the decision as a hand-written
 * `grep -qiE` chain, and nothing held the two to the same answers: the KEEP IN SYNC note in
 * shared/helpers.js covers `TRIGGER_TAG_ALIASES` only. The classification itself was
 * unguarded, and `install.sh` registers the `.sh` copy on mac and Linux — so the unguarded
 * implementation was the one actually running for most users.
 *
 * Measured before this test existed: 7 of the 18 commands below were classified differently.
 * `git tag` reached no trigger at all on mac/Linux, so a release tag — the moment a commit
 * rule most wants to speak — was silent. `docker compose build` and `docker compose push`
 * likewise. In the other direction `docker.*up` matched `docker logs backup` and
 * `docker ps | grep uptime`, because `backup` and `uptime` both contain "up": reading a log
 * produced a full deployment rule listing. v1.26.149 squared the answers; v1.26.150 deleted
 * the chain.
 *
 * Keep this table even though the second list is gone. It is what would catch the wrapper
 * being dropped, the pipe losing a multi-line command, or someone reintroducing a shortcut
 * ahead of the node call — all of which look exactly like the original defect from outside.
 *
 * The shell side is observed by running the real hook, never by restating what it does here.
 * A third copy of the logic would be the defect this file exists to catch, written into the
 * thing catching it.
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
  // v1.26.155 — outward sends. The standard for this ("run an independent review before
  // anything goes out") was tagged `trigger:send` by its author and nothing ever asked for
  // that tag, so it had never fired. Measured 2026-08-12: an issue was filed that afternoon
  // and the standard did not appear, because none of these classified as anything at all.
  { command: 'gh issue create --title x --body-file b.md', expected: 'send' },
  { command: 'gh issue comment 97 -F reply.md', expected: 'send' },
  { command: 'gh pr create --fill', expected: 'send' },
  { command: 'gh pr review 12 --approve', expected: 'send' },
  // Reading is not sending. A reminder about reviewing outward content in front of every
  // `gh issue list` is one that gets scrolled past, and then it is gone for the real case too.
  { command: 'gh issue list', expected: null },
  { command: 'gh pr view 3', expected: null },
  // A release publishes a build, so it goes with the deploys rather than the sends — the same
  // reasoning that keeps `install` off a plain curl: the label is shown to the user.
  { command: 'gh release create v1.2.3', expected: 'deploy' },
  // The two that must not have been stolen by the new branch, since both are matched earlier.
  { command: 'gh pr create && git push', expected: 'deploy' },
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

      tmpHome = stageHookHome({ apiUrl: baseUrl });
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    /**
     * Run the real hook with one command and report what it classified it as.
     *
     * `session_id` is per-command, and that is not decoration. The hook keys its once-an-hour
     * window on the session, so without one every run here shares the key `default`: they were
     * already coupled when they ran in sequence, and running them together would have had them
     * writing that state file over each other.
     */
    function classify(command, index) {
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
          session_id: `parity-${index}`,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
        }));
      });
    }

    /**
     * Every command is classified up front, a few at a time, and each `it` below reads its
     * answer.
     *
     * One spawn per test, in sequence, took 55 seconds on Windows — each one starts bash, which
     * starts node more than once. That is slow enough that under a loaded parallel suite run it
     * exceeded the 300s test timeout and this file went red for no reason anyone could see:
     * measured 2026-08-15, alongside an unrelated file that timed out in the same run. A test
     * that fails only when the machine is busy is a false red, and a false red teaches people
     * to skim.
     *
     * Bounded rather than all at once: thirty concurrent bash-plus-node trees is a different way
     * to overload the same machine.
     */
    const results = new Map();

    before(async () => {
      const CONCURRENCY = 4;
      const queue = COMMANDS.map(({ command }, index) => ({ command, index }));
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        for (;;) {
          const job = queue.shift();
          if (!job) return;
          results.set(job.command, await classify(job.command, job.index));
        }
      });
      await Promise.all(workers);
    });

    for (const { command, expected } of COMMANDS) {
      // Spawned unconditionally, as tests/iron-rule-install-trigger.test.js already does. A
      // `bash is missing` skip would turn the whole half of this file that guards the drifting
      // copy into a green no-op on any machine that happened not to resolve it.
      it(`${command} → ${expected}`, () => {
        const r = results.get(command);
        assert.ok(r, `no result was collected for ${command} — the setup above did not run it`);
        assert.equal(r.status, 0,
          `a hook must never fail the tool call it inspects. stderr=${r.stderr.slice(0, 300)}`);
        assert.equal(triggerFromHookOutput(r.stdout), expected,
          'the shell hook disagrees with shared/helpers.js. Both should reach the same function '
          + 'via hooks/ownmind-detect-trigger.js, so suspect the plumbing first: the pipe into it, '
          + 'its exit status, or something classifying ahead of the node call');
      });
    }
  });
});
