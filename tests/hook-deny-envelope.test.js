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
 * file is what keeps them from drifting apart. There were four until v1.30.26, when the shell
 * hook and hooks/lib/action-gate-cli.js — its way into the gate — were deleted.
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
const JS_HOOK = path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.js');

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

// --- Emitter 1: the action gate ---

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


test('the action gate sends the deny envelope', () => {
  const r = runGate(JS_HOOK, stageGateHome(), 'git push origin v1.2.3');
  assert.equal(r.status, 0);
  assertDenyEnvelope(r.stdout, /releases are asked about first/);
});


// --- Emitter 2: the path guard on an edit ---

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

// --- Emitter 3: the maintainer version-tag block ---

test('the version-tag block puts the whole banner in reason, not additionalContext', () => {
  // v1.30.26 — this used to lift a `node -e` program out of the shell hook and run it with the
  // two shell variables bound. That hook is deleted; the block lives in the .js hook, whose
  // guards (cwd is the OwnMind checkout, package.json version has no matching tag) a test would
  // have to fake its way into, and there is no embedded program left to lift.
  //
  // What the original was about survives as a source assertion: on a deny, additionalContext is
  // not a channel the model reads, which is how this block once arrived as a bare "denied this
  // tool" with no version number in it at all. So the banner has to be built into the reason.
  const js = fs.readFileSync(JS_HOOK, 'utf8');
  const m = /const blockReason = blockLines\.join\('\\n'\);/.exec(js);
  assert.ok(m, 'the version block no longer assembles its lines into a reason');

  const after = js.slice(m.index, m.index + 900);
  assert.match(after, /reason:\s*blockReason/,
    'the assembled banner has to reach the model through reason');
  assert.doesNotMatch(after, /additionalContext:\s*blockReason/,
    'additionalContext is not read on a deny — that is the bug this test was written for');

  // And the lines themselves still name the command to run, which is the whole point of the
  // block: a block that says "no" without saying what to do instead is a dead end.
  const lines = js.slice(Math.max(0, m.index - 900), m.index);
  assert.match(lines, /Run first: git tag/);
  assert.match(lines, /no matching git tag/);
});
