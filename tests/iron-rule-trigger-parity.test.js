import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectCommandTrigger } from '../shared/helpers.js';

/**
 * issue #92 — what a command is classified as.
 *
 * This file was written when `ownmind-iron-rule-check` shipped twice. The `.sh` hook rebuilt
 * the decision as a hand-written `grep -qiE` chain, nothing held the two to the same answers,
 * and install.sh registered the shell copy on mac and Linux — so the unguarded implementation
 * was the one most people were running. Measured before this test existed: 7 of the rows below
 * were classified differently by the two. `git tag` reached no trigger at all on mac and Linux,
 * so a release tag — the moment a version-sync rule most wants to speak — was silent. In the
 * other direction `docker.*up` matched `docker logs backup` and `docker ps | grep uptime`,
 * because "backup" and "uptime" both contain "up".
 *
 * The `.sh` is deleted (v1.30.26): nothing had registered it since v1.30.15. So there is no
 * parity left to check, and what remains is the half that was always the point — the table.
 * It is written out rather than derived from `detectCommandTrigger`, because a table that asks
 * the reference what it thinks would keep agreeing with itself after somebody edits the
 * reference by accident.
 */

/**
 * The commands the classifier is pinned on, and the answer shared/helpers.js gives.
 *
 * Every row is here because it once separated two implementations of this decision, or pins a
 * boundary one of them got wrong. The second implementation is gone; the rows are what it cost
 * to find out they disagreed, so they stay. `expected` is deliberately written out rather than derived from
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

describe('issue #92 — shared/helpers.js classifies each command', () => {
  for (const { command, expected } of COMMANDS) {
    it(`${command} → ${expected}`, () => {
      assert.equal(detectCommandTrigger(command), expected);
    });
  }

  it('the table is not empty, and every row states an answer', () => {
    // A table that emptied itself would turn every assertion above into nothing at all.
    assert.ok(COMMANDS.length >= 20, `only ${COMMANDS.length} rows; this table had 26`);
    for (const row of COMMANDS) {
      assert.equal(typeof row.command, 'string');
      assert.ok('expected' in row, `${row.command} states no expected trigger`);
    }
  });
});
