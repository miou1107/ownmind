/**
 * One shape for every PreToolUse block, checked by running the real emitters.
 *
 * WHY THIS FILE EXISTS
 *
 * The hooks used to stop a tool call with `{decision:'block', reason}` and nothing else.
 * Claude Code 2.1.226 honours that verdict and throws the words away. Measured on
 * 2026-08-16 against the installed hook: releasing v1.30.8 was correctly stopped by the
 * owner's own rule 820, the assistant was told only
 *
 *     Hook PreToolUse:Bash denied this tool
 *
 * and the user was told nothing whatsoever. No rule name, no reason, and no sign that a
 * one-word answer would clear it. The `systemMessage` written for the user and the `reason`
 * written for the assistant were both produced correctly by the gate and both discarded by
 * the harness. Adding `hookSpecificOutput.permissionDecision: 'deny'` with
 * `permissionDecisionReason` and re-running the same block delivered the full text.
 *
 * A block nobody can read is a block nobody can clear, so the next person to hit one goes
 * looking for a way around it — and the way around is writing the approval file by hand.
 * The silent block is what makes that tempting rather than merely possible.
 *
 * WHY BOTH PAIRS OF FIELDS
 *
 * `decision`/`reason` is what builds older than the permissionDecision contract read.
 * `hookSpecificOutput.permissionDecision`/`permissionDecisionReason` is what current ones
 * read. Both carry the same verdict and the same text, so a build that understands both
 * cannot be told two different things.
 *
 * WHY THE SHAPE IS INLINED AT FOUR SITES INSTEAD OF IMPORTED FROM ONE
 *
 * Same reason `gateNotice()` is a literal duplicate rather than a shared helper: a block
 * must never be reachable only through a file that could be missing. An import that fails
 * inside the gate's own try/catch turns a block into an allow — that is a message module
 * holding the power to switch enforcement off. So each emitter carries the object, and this
 * file is what keeps the four from drifting apart.
 *
 * WHY additionalContext IS GONE FROM DENIALS
 *
 * On a deny it is not a channel the model reads. The version-tag block put its entire
 * message there and passed a one-line summary as the reason, so that block arrived without
 * the version number in it at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { editReminder } from '../hooks/ownmind-edit-reminder.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(repoRoot, 'hooks', 'lib', 'action-gate-cli.js');
const JS_HOOK = path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.js');
const SH_HOOK = path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.sh');

/**
 * The whole contract, in one place. Every emitter is held to this.
 *
 * @param {string} stdout what the emitter wrote
 * @param {RegExp} carries something the reason must actually say, so an empty-but-shaped
 *   envelope cannot pass
 */
function assertDenyEnvelope(stdout, carries) {
  assert.ok(stdout.trim(), 'a block must print something');
  const out = JSON.parse(stdout);

  // The pair current builds read.
  assert.equal(out.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny',
    'without this the harness reduces the block to "denied this tool"');
  assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? '', carries,
    'the reason has to reach the model through the field the model is given');

  // The pair older builds read, saying the same thing.
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, out.hookSpecificOutput.permissionDecisionReason,
    'the two channels must not be able to say different things');

  // Not a denial channel; carrying the message here is how a block loses it.
  assert.equal(out.hookSpecificOutput.additionalContext, undefined,
    'additionalContext is not read on a deny — the message belongs in the reason');
  return out;
}

// --- Emitter 1 & 2: the action gate, through both wirings ---

const ASK_GUARD = {
  id: 820,
  kind: 'action',
  title: 'releases are asked about first',
  triggers: ['deploy'],
  checks: [],
  read_required: false,
  ask_first: true,
  ask_mode: 'verbal',
  rule_text: 'Ask before releasing.',
  rules_hash: createHash('sha256').update('Ask before releasing.').digest('hex'),
};

function stageGateHome(guards = [ASK_GUARD]) {
  const home = tempDir('deny-envelope-home-');
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify({ selectors: [], guards, injectables: [] })
  );
  return home;
}

function runGate(program, home, command) {
  return spawnSync(process.execPath, [program], {
    input: JSON.stringify({
      session_id: 'deny-envelope', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command },
    }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

test('the gate CLI names the rule it stopped, in the field the model is given', () => {
  const r = runGate(CLI_PATH, stageGateHome(), 'git push origin v1.2.3');
  assert.equal(r.status, 0, 'the gate always exits 0');
  const out = assertDenyEnvelope(r.stdout, /releases are asked about first/);
  assert.match(out.systemMessage, /OwnMind stopped it/, 'the line for the user still rides along');
});

test('the .js twin sends the same envelope as the CLI', () => {
  const r = runGate(JS_HOOK, stageGateHome(), 'git push origin v1.2.3');
  assert.equal(r.status, 0);
  assertDenyEnvelope(r.stdout, /releases are asked about first/);
});

test('the two wirings do not differ in what a platform is told', () => {
  const fromCli = JSON.parse(runGate(CLI_PATH, stageGateHome(), 'git push origin v1.2.3').stdout);
  const fromJs = JSON.parse(runGate(JS_HOOK, stageGateHome(), 'git push origin v1.2.3').stdout);
  assert.deepEqual(Object.keys(fromCli).sort(), Object.keys(fromJs).sort());
  assert.deepEqual(
    Object.keys(fromCli.hookSpecificOutput).sort(),
    Object.keys(fromJs.hookSpecificOutput).sort()
  );
  assert.equal(fromCli.reason, fromJs.reason);
  assert.equal(fromCli.systemMessage, fromJs.systemMessage);
});

// --- Emitter 3: the path guard on an edit ---

test('a blocked edit tells the assistant which standard it hit', async () => {
  const repo = tempDir('om-deny-envelope-fixture-');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin',
    'https://example.com/deny-envelope-fixture.git']);
  const target = path.join(repo, 'ci', 'projects.yml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'x\n');

  const out = await editReminder({
    version: 'test', apiKey: '', apiUrl: '', now: Date.now(), sessionId: 's1',
    filePath: target,
    guards: [{
      id: 412, title: 'ci belongs to the colleague',
      repo_match: 'deny-envelope-fixture', paths: ['ci/**'], owner: 'Colleague',
    }],
  });
  const parsed = assertDenyEnvelope(out, /412/);
  assert.match(parsed.reason, /Colleague/);
  // Denied tool calls print one generic line and keep the rest, so the only way this reaches
  // the person at the keyboard is if the assistant is asked to say it.
  assert.match(parsed.reason, /Tell the user this/);
});

// --- Emitter 4: the maintainer version-tag block, inside the shell hook ---

/**
 * That block is a `node -e` inside the .sh, guarded by conditions (cwd is the OwnMind
 * checkout, package.json version has no matching tag) that a test would have to fake its way
 * into. So its program is lifted out and run for real with the two shell variables bound —
 * the same code the hook executes, without staging a fake release.
 */
function runShellVersionBlock() {
  const sh = fs.readFileSync(SH_HOOK, 'utf8');
  // Anchored on the banner text, not on `node -e` alone: the hook runs several node
  // programs and the first one is not this one.
  const m = sh.match(/node -e "\n((?:(?!node -e ")[\s\S])*?版號卡控[\s\S]*?)\n\s*"/);
  assert.ok(m, 'the version-tag block moved; this test can no longer find it');
  const program = m[1].replace(/\$VERSION/g, '9.9.9').replace(/\$PKG_VER/g, '9.9.9');
  const r = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('the version-tag block carries the version number it is asking for', () => {
  const out = assertDenyEnvelope(runShellVersionBlock(), /git tag v9\.9\.9/);
  assert.match(out.reason, /版號卡控/, 'the whole banner rides the reason, not additionalContext');
});
