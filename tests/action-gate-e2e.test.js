/**
 * End-to-end tests for the action-gate PreToolUse wiring.
 *
 * The unit tests in action-gate.test.js exercise evaluateGate in-process. These spawn the
 * real programs a user's machine runs — hooks/lib/action-gate-cli.js (what the registered
 * .sh hook calls) and hooks/ownmind-iron-rule-check.js (the Windows twin) — against a
 * staged HOME carrying an enforcement.json, and read only what lands on stdout. That is
 * the whole contract: a block is a JSON decision envelope, an allow is silence, and a gate
 * that cannot run says so instead of going quiet.
 */

import { strict as assert } from 'assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { stageHookHome } from './helpers/hook-home.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const CLI_PATH = path.join(repoRoot, 'hooks', 'lib', 'action-gate-cli.js');
const SH_HOOK = path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.sh');
const JS_HOOK = path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.js');

const DEGRADED_LINE =
  '[OwnMind] the action gate could not run in full - receipts unavailable, checks still enforced';

/**
 * The Task 1 guard shape, pattern-scoped (plan Amendment 1). The shared classifier calls
 * every `git push` a deploy on purpose; applies_pattern is how an individual rule narrows
 * itself so plain branch pushes never reach its read gate.
 */
const COMPOSE_GUARD = {
  id: 918,
  kind: 'action',
  title: 'compose no-cache',
  triggers: ['deploy'],
  applies_pattern: '(^|[;&|]\\s*|\\bsudo\\s+)docker\\s+(compose\\s+)?build',
  checks: [
    { type: 'must_not_match', pattern: '(^|\\s)docker\\s+build(\\s|$)', reason: 'use docker compose build (IR-023)' },
    { type: 'must_match', pattern: '--no-cache', reason: 'add --no-cache (IR-018)' },
  ],
  read_required: true,
  ask_first: false,
  rule_text: 'Deploys use docker compose build --no-cache.',
  rules_hash: createHash('sha256').update('Deploys use docker compose build --no-cache.').digest('hex'),
};

/** IR-136-style: applies only to version-tag pushes, so feature/main pushes pass. */
const TAG_PUSH_GUARD = {
  id: 136,
  kind: 'action',
  title: 'a version-tag push is a deployment (IR-136)',
  triggers: ['deploy'],
  applies_pattern: 'git\\s+push\\b.*\\s(refs\\/tags\\/)?(v\\d|ima-v|ima-rc)',
  checks: [],
  read_required: true,
  ask_first: false,
  rule_text: 'A version-tag push deploys; read the release rule before pushing the tag.',
  rules_hash: createHash('sha256').update('A version-tag push deploys; read the release rule before pushing the tag.').digest('hex'),
};

const DEFAULT_GUARDS = [COMPOSE_GUARD, TAG_PUSH_GUARD];

/** Stage a HOME whose enforcement cache carries the given guards. */
function stageGateHome(guards = DEFAULT_GUARDS) {
  const home = tempDir('gate-e2e-home-');
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify({ selectors: [], guards, injectables: [] })
  );
  return { home };
}

/** Run the gate CLI exactly as the .sh hook does: payload on stdin, HOME staged. */
function runGateCli({ home, command, sessionId = 'e2e-session' }) {
  const payload = JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });
  return spawnSync(process.execPath, [CLI_PATH], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

/** The commands a working day is made of. Not one of them may be slowed or blocked. */
const EVERYDAY = ['ls -la', 'git status', 'git diff', 'git push origin feature-x', 'npm test',
  'node script.js', 'grep -rn docker src/', 'echo "docker build ."', 'docker compose ps',
  'git grep "docker build"', 'cat README.md', 'rg pattern', 'pwd', 'whoami', 'df -h',
  'git log --oneline', 'npm run lint', 'node --test tests/x.test.js', 'git fetch --tags',
  'curl -s https://example.com', 'tail -f log.txt', 'mkdir -p tmp', 'cp a b', 'mv a b',
  'git checkout -b feat/x', 'git add -A', 'sed -n 1,10p file', 'wc -l file', 'ls docs', 'git stash list'];

test('the first deploy attempt is read-blocked with the full decision envelope', () => {
  const { home } = stageGateHome();
  const r = runGateCli({ home, command: 'docker compose build --no-cache api' });
  assert.equal(r.status, 0, 'the gate always exits 0');
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /docker compose build --no-cache/, 'the rule text rides the model-facing reason');
  assert.match(out.systemMessage, /blocked until the rule/, 'the user sees why');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.additionalContext, '');
});

test('the retry after a read-block passes in silence', () => {
  const { home } = stageGateHome();
  runGateCli({ home, command: 'docker compose build --no-cache api' }); // read-block, receipt written
  const retry = runGateCli({ home, command: 'docker compose build --no-cache api' });
  assert.equal(retry.status, 0);
  assert.equal(retry.stdout.trim(), '', 'an allow prints nothing');
});

test('a plain docker build is check-blocked once the rule is read', () => {
  const { home } = stageGateHome();
  runGateCli({ home, command: 'docker build .' }); // first contact: read-block writes the receipt
  const second = runGateCli({ home, command: 'docker build .' });
  const out = JSON.parse(second.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /use docker compose build/, 'the violated check names the fix');
  assert.match(out.systemMessage, /blocked/);
});

test('the everyday pack crosses the gate untouched', () => {
  const { home } = stageGateHome();
  for (const command of EVERYDAY) {
    const r = runGateCli({ home, command });
    assert.equal(r.status, 0, `gate CLI failed on: ${command}`);
    assert.equal(r.stdout.trim(), '', `wrongly gated: ${command}`);
  }
  // The two pushes Amendment 1 exists for: pattern-scoped guards let them through.
  for (const command of ['git push origin main', 'git push origin feature-x']) {
    assert.equal(runGateCli({ home, command }).stdout.trim(), '', `wrongly gated: ${command}`);
  }
});

test('a version-tag push is gated by the pattern-scoped guard', () => {
  const { home } = stageGateHome();
  const first = runGateCli({ home, command: 'git push origin v1.2.9' });
  const out = JSON.parse(first.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /IR-136/);
  const retry = runGateCli({ home, command: 'git push origin v1.2.9' });
  assert.equal(retry.stdout.trim(), '', 'reading the rule unblocks the tag push');
});

test('a corrupt enforcement.json means nothing to enforce, not a crash', () => {
  const home = tempDir('gate-e2e-home-');
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ownmind', 'cache', 'enforcement.json'), 'not json {{{');
  const r = runGateCli({ home, command: 'docker compose build --no-cache api' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '', 'a bundle that cannot be read enforces nothing and says nothing');
});

test('a machine that has never synced stays silent', () => {
  const home = tempDir('gate-e2e-home-');
  const r = runGateCli({ home, command: 'docker compose build --no-cache api' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('a broken state dir degrades loudly on allow, and checks still enforce', () => {
  const { home } = stageGateHome();
  // A file where the state directory should be: receipts cannot exist.
  fs.writeFileSync(path.join(home, '.ownmind', 'state'), 'not a directory');

  const ok = runGateCli({ home, command: 'docker compose build --no-cache api' });
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(ok.stdout), { systemMessage: DEGRADED_LINE });

  const bad = runGateCli({ home, command: 'docker build .' });
  const out = JSON.parse(bad.stdout);
  assert.equal(out.decision, 'block', 'checks are stateless and survive the receipt outage');
  assert.match(out.reason, /use docker compose build/);
});

// --- The registered hooks carry the decision through unchanged ---

test('the .sh hook forwards a gate block and stops there', () => {
  // stageHookHome gives the .sh everything it resolves under $HOME; the apiUrl points at a
  // closed port on purpose — a block must be decided before any network is touched.
  const home = stageHookHome({ apiUrl: 'http://127.0.0.1:9' });
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify({ selectors: [], guards: DEFAULT_GUARDS, injectables: [] })
  );
  const payloadFor = (command) => JSON.stringify({
    session_id: 'e2e-session',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });
  const runSh = (command) => spawnSync('bash', [SH_HOOK], {
    input: payloadFor(command),
    encoding: 'utf8',
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });

  const first = runSh('docker compose build --no-cache api');
  assert.equal(first.status, 0);
  const out = JSON.parse(first.stdout);
  assert.equal(out.decision, 'block', 'the .sh echoes the CLI decision verbatim');
  assert.match(out.systemMessage, /blocked until the rule/);

  // The retry is allowed by the gate; whatever the reminder flow says next, it must not block.
  const retry = runSh('docker compose build --no-cache api');
  assert.equal(retry.status, 0);
  assert.ok(!retry.stdout.includes('"decision"'), 'the retry must not be blocked');

  // Ordering proof: the shared classifier gives a plain `docker build` no trigger at all,
  // so this command reaches the gate only because the gate runs BEFORE the .sh's
  // empty-trigger exit. If someone moves the wiring below that exit, this line goes red.
  const bare = runSh('docker build .');
  assert.equal(JSON.parse(bare.stdout).decision, 'block',
    'the gate must run before the empty-trigger exit can skip it');
});

// --- The gate owns stdout for the turn, even when the one-time upgrade is armed ---
//
// The .sh carries a hitchhiker: a one-time "SessionStart hook missing → auto-install"
// block that echoes a {"hookSpecificOutput":…} advisory on the first tool call. It fires
// at most once per machine, guarded by a marker touch, and only when ~/.ownmind/.git is
// present and settings.json has no SessionStart hook. If it echoes and then execution
// falls through to a gate BLOCK, stdout carries TWO newline-separated JSON objects, which
// violates the single-object hook contract — a harness parser can drop the gate block and
// let a risky command run ungated. The gate must win the stdout race: it emits and exits
// before the advisory ever runs.

/** Stage a HOME whose upgrade hitchhiker is armed AND whose enforcement cache has guards. */
function stageArmedUpgradeHome() {
  const home = stageHookHome({ apiUrl: 'http://127.0.0.1:9' });
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify({ selectors: [], guards: DEFAULT_GUARDS, injectables: [] })
  );
  // Arm the one-time upgrade: the three conditions sh:65 keys on are
  //   (a) install marker absent — stageHookHome never creates it,
  //   (b) ~/.ownmind/.git present — created here (an empty dir; the block's `git pull`
  //       fails fast into 2>/dev/null and the advisory still echoes),
  //   (c) settings.json carries no SessionStart hook — stageHookHome writes only mcpServers.
  fs.mkdirSync(path.join(home, '.ownmind', '.git'), { recursive: true });
  return home;
}

function runShIn(home, command) {
  return spawnSync('bash', [SH_HOOK], {
    input: JSON.stringify({
      session_id: 'e2e-session',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
    }),
    encoding: 'utf8',
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

test('a gate block with the upgrade armed emits exactly ONE JSON object — the block', () => {
  const home = stageArmedUpgradeHome();
  const r = runShIn(home, 'docker compose build --no-cache api');

  assert.equal(r.status, 0, `hook must exit 0; stderr=${r.stderr.slice(0, 300)}`);
  // The contract: stdout is exactly one JSON object. Two objects (upgrade advisory + gate
  // block) make JSON.parse of the whole stream throw — that is the pre-fix red state.
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
    `stdout must be exactly one JSON object, got:\n${r.stdout}`);
  assert.equal(parsed.decision, 'block',
    'the single object must be the gate block, not the upgrade advisory');
  assert.match(parsed.systemMessage, /blocked until the rule/, 'the user sees why');
});

test('a non-blocked command with the upgrade armed still lets the advisory through (one object)', () => {
  const home = stageArmedUpgradeHome();
  // `ls -la` is neither gate-blockable nor a trigger, so the only thing with anything to
  // say this turn is the upgrade advisory. It must arrive as one clean JSON object.
  const r = runShIn(home, 'ls -la');

  assert.equal(r.status, 0, `hook must exit 0; stderr=${r.stderr.slice(0, 300)}`);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
    `stdout must be exactly one JSON object, got:\n${r.stdout}`);
  assert.ok(!parsed.decision, 'a non-blocked command is not a gate block');
  assert.ok(parsed.hookSpecificOutput, 'the upgrade advisory rides a hookSpecificOutput envelope');
  assert.match(parsed.hookSpecificOutput.additionalContext, /自動升級|SessionStart/,
    'the one object is the upgrade advisory');
});

test('the .js twin blocks and allows the same way', () => {
  const { home } = stageGateHome();
  const payload = JSON.stringify({
    session_id: 'e2e-session',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'docker compose build --no-cache api' },
  });
  const run = () => spawnSync(process.execPath, [JS_HOOK], {
    input: payload,
    encoding: 'utf8',
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const first = run();
  assert.equal(first.status, 0);
  const out = JSON.parse(first.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /docker compose build --no-cache/);
  assert.match(out.systemMessage, /blocked until the rule/);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');

  const retry = run();
  assert.equal(retry.status, 0);
  assert.ok(!retry.stdout.includes('"decision"'), 'the retry passes the gate');
});
