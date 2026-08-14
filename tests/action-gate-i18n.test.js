/**
 * Tests for the gate family wired through t(): the four block userLine sites in
 * hooks/lib/action-gate.js (verbal ask, code ask/limit, read-block, check-block), and the
 * failopen/degraded notices duplicated in hooks/lib/action-gate-cli.js and
 * hooks/ownmind-iron-rule-check.js.
 *
 * Binding constraints this file pins:
 *   - userLine (systemMessage, user-facing) renders per OWNMIND_LOCALE_FORCE.
 *   - reason (hookSpecificOutput.reason, model-facing) NEVER changes with locale — it is a
 *     raw English template, untouched by this task. Proven directly, not assumed.
 *   - with force=en, every userLine is byte-identical to the pre-change literal (copied from
 *     docs/superpowers/specs/2026-08-14-gate-i18n/string-inventory.json, not retyped).
 *   - a broken i18n module must never change what the gate DECIDES (block/allow/reason) — only
 *     degrade the notice text, and only the notice text, down to a safe English fallback.
 *
 * Locale is pinned via the OWNMIND_LOCALE_FORCE test seam (hooks/lib/locale.js). See
 * tests/hook-i18n.test.js for t()'s own total-function guarantees (never throws on a missing
 * or corrupt per-locale dictionary) — this file does not re-prove that; it proves the gate's
 * integration with it.
 */

import { strict as assert } from 'assert';
import { test, afterEach } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGate } from '../hooks/lib/action-gate.js';
import { ensureKey, ensureNonce } from '../hooks/lib/gate-receipt.js';
import { tempDir } from './helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const CLI_PATH = path.join(repoRoot, 'hooks', 'lib', 'action-gate-cli.js');
const JS_HOOK = path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.js');

const ORIGINAL_FORCE = process.env.OWNMIND_LOCALE_FORCE;
afterEach(() => {
  if (ORIGINAL_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_FORCE;
});

function prepStateDir() {
  const dir = tempDir('gate-i18n-eval-');
  ensureKey(dir);
  ensureNonce(dir, 's1');
  return dir;
}

function mkGuard(over = {}) {
  return {
    id: 918, kind: 'action', title: 'compose no-cache', triggers: ['deploy'],
    checks: [
      { type: 'must_not_match', pattern: '(^|\\s)docker\\s+build(\\s|$)', reason: 'use docker compose build (IR-023)' },
      { type: 'must_match', pattern: '--no-cache', reason: 'add --no-cache (IR-018)' },
    ],
    read_required: true, ask_first: false,
    rule_text: 'Deploys use docker compose build --no-cache.',
    rules_hash: createHash('sha256').update('Deploys use docker compose build --no-cache.').digest('hex'),
    ...over,
  };
}

// --- zh: all block kinds carry the zh userLine with placeholders filled ---

test('zh: verbal-mode ask userLine', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const dir = prepStateDir();
  const g = mkGuard({ id: 700, ask_first: true, ask_mode: 'verbal', checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(ask.kind, 'ask');
  assert.equal(
    ask.userLine,
    '[OwnMind] ⛔ 「compose no-cache」這個動作要你點頭才放行。回「go」放行一次、回「no」取消。'
  );
});

test('zh: code-mode ask userLine (action variant)', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const dir = prepStateDir();
  const g = mkGuard({ id: 701, ask_first: true, checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(ask.kind, 'ask');
  const code = ask.userLine.match(/同意碼：(\d{6})/)?.[1];
  assert.ok(code, 'a 6-digit code must be present');
  assert.equal(
    ask.userLine,
    `[OwnMind] ⛔ 「compose no-cache」要你同意這個動作。同意碼：${code}（把它貼給 AI 就放行一次）`
  );
});

test('zh: limit userLine (code-mode, 3-strikes variant)', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const dir = prepStateDir();
  const g = mkGuard({ id: 702, read_required: false });
  for (let i = 0; i < 3; i += 1) {
    evaluateGate({ command: 'docker build .', guards: [g], stateDir: dir, sessionId: 's1' });
  }
  const limit = evaluateGate({ command: 'docker build .', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(limit.kind, 'limit');
  const code = limit.userLine.match(/同意碼：(\d{6})/)?.[1];
  assert.ok(code, 'a 6-digit code must be present');
  assert.equal(
    limit.userLine,
    `[OwnMind] ⛔ 「compose no-cache」連續擋了同一個指令 3 次，要你決定放不放行。同意碼：${code}（把它貼給 AI 就放行一次）`
  );
});

test('zh: read-block userLine', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const dir = prepStateDir();
  const g = mkGuard({ id: 703 });
  const r = evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(r.kind, 'read');
  assert.equal(r.userLine, '[OwnMind] ⛔ 先讀過規矩「compose no-cache」才放行（AI 讀完重試就自動解鎖）');
});

test('zh: check-block userLine', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const dir = prepStateDir();
  const g = mkGuard({ id: 704 });
  evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' }); // consume read
  const r = evaluateGate({ command: 'docker compose build api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(r.kind, 'check');
  assert.equal(r.userLine, '[OwnMind] ⛔ 已擋下：add --no-cache (IR-018)');
});

// --- en regression pin: byte-identical to the pre-change literals (string-inventory.json) ---

test('en: verbal-mode ask userLine is byte-identical to the pre-change literal', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const dir = prepStateDir();
  const g = mkGuard({ id: 710, ask_first: true, ask_mode: 'verbal', checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(
    ask.userLine,
    '[OwnMind] ⛔ "compose no-cache" needs your go-ahead for this action. Reply "go" to approve it once, or "no" to cancel.'
  );
});

test('en: code-mode ask userLine is byte-identical to the pre-change literal', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const dir = prepStateDir();
  const g = mkGuard({ id: 711, ask_first: true, checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  const code = ask.userLine.match(/Approval code: (\d{6})/)?.[1];
  assert.ok(code, 'a 6-digit code must be present');
  assert.equal(
    ask.userLine,
    `[OwnMind] ⛔ "compose no-cache" wants your approval for: this action. Approval code: ${code} (paste it to the AI to allow it once)`
  );
});

test('en: limit userLine is byte-identical to the pre-change literal', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const dir = prepStateDir();
  const g = mkGuard({ id: 712, read_required: false });
  for (let i = 0; i < 3; i += 1) {
    evaluateGate({ command: 'docker build .', guards: [g], stateDir: dir, sessionId: 's1' });
  }
  const limit = evaluateGate({ command: 'docker build .', guards: [g], stateDir: dir, sessionId: 's1' });
  const code = limit.userLine.match(/Approval code: (\d{6})/)?.[1];
  assert.ok(code, 'a 6-digit code must be present');
  assert.equal(
    limit.userLine,
    `[OwnMind] ⛔ "compose no-cache" wants your approval for: a command blocked 3 times in a row. Approval code: ${code} (paste it to the AI to allow it once)`
  );
});

test('en: read-block userLine is byte-identical to the pre-change literal', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const dir = prepStateDir();
  const g = mkGuard({ id: 713 });
  const r = evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(r.userLine, '[OwnMind] ⛔ blocked until the rule "compose no-cache" is read (auto-unblocks on retry)');
});

test('en: check-block userLine is byte-identical to the pre-change literal', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const dir = prepStateDir();
  const g = mkGuard({ id: 714 });
  evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  const r = evaluateGate({ command: 'docker compose build api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(r.userLine, '[OwnMind] ⛔ blocked: add --no-cache (IR-018)');
});

// --- reason (model-facing) never localizes, and gate decisions never depend on locale ---

test('reason strings stay English regardless of locale (read-block and check-block)', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const dir = prepStateDir();
  const g = mkGuard({ id: 720 });
  const readBlock = evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.match(readBlock.reason, /Read this rule before acting/);
  assert.match(readBlock.reason, /Deploys use docker compose build --no-cache\./);
  const checkBlock = evaluateGate({ command: 'docker compose build api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.match(checkBlock.reason, /The command violates "compose no-cache": add --no-cache \(IR-018\)\. Fix the command and retry\./);
});

test('reason strings stay English regardless of locale (ask/limit)', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const dir = prepStateDir();
  const g = mkGuard({ id: 721, ask_first: true, checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.match(ask.reason, /needs the user's explicit go for this action/);
  assert.ok(!/[一-鿿]/.test(ask.reason.replace(/好/, '')), 'the ask reason carries no Chinese text (好 is the one protocol word allowed by policy, and is not used on this path)');
});

test('gate decision fields (action/kind/reason/code_issued) are identical across every locale — only userLine changes', () => {
  const results = {};
  for (const locale of ['en', 'zh', undefined]) {
    if (locale === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
    else process.env.OWNMIND_LOCALE_FORCE = locale;
    const dir = prepStateDir();
    const g = mkGuard({ id: 730 });
    const r = evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
    results[String(locale)] = r;
  }
  const [first, ...rest] = Object.values(results);
  for (const r of rest) {
    assert.equal(r.action, first.action);
    assert.equal(r.kind, first.kind);
    assert.equal(r.reason, first.reason, 'reason (model-facing) must be byte-identical across locales');
    assert.equal(r.guardId, first.guardId);
  }
});

// --- CLI: the degraded notice is localized (normal operation, i18n intact) ---

function stageEnforcement(home, guards) {
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify({ selectors: [], guards, injectables: [] })
  );
}

function runGateCli({ home, command, sessionId = 'i18n-e2e', env = {} }) {
  const payload = JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });
  return spawnSync(process.execPath, [CLI_PATH], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
  });
}

test('CLI: the degraded notice is rendered in zh when OWNMIND_LOCALE_FORCE=zh', () => {
  const home = tempDir('gate-i18n-cli-degraded-');
  stageEnforcement(home, [mkGuard({ id: 740 })]);
  // A file where the state directory should be: receipts cannot exist (same trick as the
  // existing "a broken state dir degrades loudly on allow" e2e case).
  fs.writeFileSync(path.join(home, '.ownmind', 'state'), 'not a directory');

  const r = runGateCli({ home, command: 'docker compose build --no-cache api', env: { OWNMIND_LOCALE_FORCE: 'zh' } });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    systemMessage: '[OwnMind] 閘門部分失效：讀取回執暫時無法使用，指令檢查仍照常把關',
  });
});

// --- CLI: the failopen notice is localized (normal operation: a genuinely thrown exception,
// unrelated to i18n — a guard bundle whose `checks` field is not an array is not iterable,
// which is exactly the class of malformed-sync-data failure this fail-open path exists for) ---

test('CLI: the failopen notice is rendered in zh when OWNMIND_LOCALE_FORCE=zh, and the command still runs', () => {
  const home = tempDir('gate-i18n-cli-failopen-');
  stageEnforcement(home, [{
    id: 741, kind: 'action', title: 'malformed', triggers: ['deploy'],
    checks: {}, // not an array: `for (const c of guard.checks || [])` throws TypeError
    read_required: false, ask_first: false, rule_text: 'x', rules_hash: 'h',
  }]);

  const r = runGateCli({ home, command: 'docker compose build api', env: { OWNMIND_LOCALE_FORCE: 'zh' } });
  assert.equal(r.status, 0, 'the gate always exits 0, even when it fails open');
  assert.deepEqual(JSON.parse(r.stdout), {
    systemMessage: '[OwnMind] 閘門這次沒跑起來，這個指令「沒有」被把關',
  });
});

test('JS hook: the failopen notice is rendered in zh when OWNMIND_LOCALE_FORCE=zh, and the command still runs', () => {
  const home = tempDir('gate-i18n-jshook-failopen-');
  fs.mkdirSync(path.join(home, '.ownmind'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ownmind', 'package.json'), JSON.stringify({ version: '99.99.99' }));
  stageEnforcement(home, [{
    id: 742, kind: 'action', title: 'malformed', triggers: ['deploy'],
    checks: {}, read_required: false, ask_first: false, rule_text: 'x', rules_hash: 'h',
  }]);

  const payload = JSON.stringify({
    session_id: 'i18n-e2e', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'docker compose build api' },
  });
  const r = spawnSync(process.execPath, [JS_HOOK], {
    input: payload,
    encoding: 'utf8',
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, OWNMIND_LOCALE_FORCE: 'zh' },
  });
  assert.equal(r.status, 0, `hook must exit 0; stderr=${r.stderr.slice(0, 300)}`);
  assert.deepEqual(JSON.parse(r.stdout), {
    systemMessage: '[OwnMind] 閘門這次沒跑起來，這個指令「沒有」被把關',
  });
});

// --- A totally broken i18n module must never crash any of the three gate entry points, nor
// change what any of them decide — it must fall back to the plain English literal, exactly
// as if i18n.js did not exist. Covers all three: the CLI, the .js hook twin, and the
// approve-action CLI (review found the third one crashing with empty stdout — see below). ---

/**
 * Stages an isolated directory whose hooks/lib/i18n.js fails to parse, with everything else
 * needed to load `entryRelPath` present too. `copyRelPaths` are real file-CONTENT copies (for
 * files whose OWN `./i18n.js`-relative resolution must land on the staged broken one —
 * i.e. hooks/lib/action-gate.js and the entry file itself); `symlinkRelPaths` are symlinks to
 * the real files (for everything else on the static import graph that just needs to load,
 * where redirecting its own further imports does not matter).
 *
 * These must be real copies, not symlinks, for the two files named above: Node's ESM loader
 * resolves a symlinked module's `import.meta.url` to its REAL path by default (verified
 * empirically — see task report), so a symlinked action-gate.js would resolve its own
 * `./i18n.js` against the real repo path and silently load the real, working i18n.js instead
 * of this staged broken one. `shared/` is always safe to symlink whole, because none of the
 * files under it have relative imports of their own that need mis-resolving.
 *
 * Never touches the real hooks/lib/i18n.js — every other test file in this suite (after Task
 * 3) transitively imports it through the gate, so corrupting the real one, even briefly,
 * would be a shared-file race against every other test file node's parallel test runner may
 * run concurrently.
 */
function stageBrokenI18nTree({ entryRelPath, copyRelPaths, symlinkRelPaths = [] }) {
  const tempRoot = tempDir('gate-broken-i18n-');
  fs.mkdirSync(path.join(tempRoot, 'hooks', 'lib'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'shared'), path.join(tempRoot, 'shared'));
  for (const rel of symlinkRelPaths) {
    fs.symlinkSync(path.join(repoRoot, rel), path.join(tempRoot, rel));
  }
  for (const rel of [...copyRelPaths, entryRelPath]) {
    fs.mkdirSync(path.dirname(path.join(tempRoot, rel)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, rel), path.join(tempRoot, rel));
  }
  // A syntax error: the dynamic `import('./i18n.js')` this simulates must REJECT, not just
  // return something t()-shaped, to prove the guard around the import itself (not just around
  // a well-formed-but-empty module).
  fs.writeFileSync(path.join(tempRoot, 'hooks', 'lib', 'i18n.js'), 'export function t( { this is not valid js');
  return path.join(tempRoot, entryRelPath);
}

test('CLI: an unloadable i18n.js falls back to the English literal, exits 0, and fails the command open', () => {
  const cliPath = stageBrokenI18nTree({
    entryRelPath: 'hooks/lib/action-gate-cli.js',
    copyRelPaths: ['hooks/lib/action-gate.js'],
    symlinkRelPaths: ['hooks/lib/gate-receipt.js', 'hooks/lib/enforcement-cache.js', 'hooks/lib/locale.js'],
  });
  const home = tempDir('gate-broken-i18n-home-');
  stageEnforcement(home, [mkGuard({ id: 750 })]);

  const payload = JSON.stringify({
    session_id: 'broken-i18n', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'docker compose build --no-cache api' }, // would normally read-block
  });
  const r = spawnSync(process.execPath, [cliPath], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, OWNMIND_LOCALE_FORCE: 'zh' },
  });
  assert.equal(r.status, 0, `must exit 0 even with a broken i18n module; stderr=${r.stderr.slice(0, 500)}`);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); }, `stdout must be valid JSON, got:\n${r.stdout}`);
  // Fails open exactly like any other exception in the gate path: no decision, just the notice.
  assert.ok(!parsed.decision, 'a broken i18n module must fail the gate OPEN, never invent a block');
  assert.equal(
    parsed.systemMessage,
    '[OwnMind] the action gate could not run - this command was NOT gated',
    'the fallback is the plain English literal even though OWNMIND_LOCALE_FORCE=zh was set — i18n itself is broken'
  );
});

test('JS hook: an unloadable i18n.js falls back to the English literal, exits 0, and fails the command open', () => {
  // The .js hook's static import list is longer than the CLI's, but only action-gate.js and
  // the entry file itself sit on the path to i18n.js — everything else here just needs to
  // load, so it is symlinked to the real (unbroken) file rather than copied.
  const hookPath = stageBrokenI18nTree({
    entryRelPath: 'hooks/ownmind-iron-rule-check.js',
    copyRelPaths: ['hooks/lib/action-gate.js'],
    symlinkRelPaths: [
      'hooks/ownmind-edit-reminder.js',
      'hooks/lib/gate-receipt.js',
      'hooks/lib/enforcement-cache.js',
      'hooks/lib/locale.js',
      'hooks/lib/hook-context-fetch.js',
    ],
  });
  const home = tempDir('gate-broken-i18n-jshook-home-');
  stageEnforcement(home, [mkGuard({ id: 751 })]);

  const payload = JSON.stringify({
    session_id: 'broken-i18n', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'docker compose build --no-cache api' },
  });
  const r = spawnSync(process.execPath, [hookPath], {
    input: payload,
    encoding: 'utf8',
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, OWNMIND_LOCALE_FORCE: 'zh' },
  });
  assert.equal(r.status, 0, `must exit 0 even with a broken i18n module; stderr=${r.stderr.slice(0, 500)}`);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); }, `stdout must be valid JSON, got:\n${r.stdout}`);
  assert.ok(!parsed.decision, 'a broken i18n module must fail the gate OPEN, never invent a block');
  assert.equal(
    parsed.systemMessage,
    '[OwnMind] the action gate could not run - this command was NOT gated',
    'the fallback is the plain English literal even though OWNMIND_LOCALE_FORCE=zh was set — i18n itself is broken'
  );
});

test('approve-action CLI: an unloadable i18n.js still prints REJECTED (not a crash with empty stdout)', () => {
  // Regression case: action-gate.js's new static `import { t } from './i18n.js'` (this task)
  // is also reachable through approve-action.js, which statically imports action-gate.js at
  // its own top level — a location that cannot be wrapped in try/catch. Left as a static
  // import there too, a broken i18n.js would crash approve-action.js with a raw stack trace
  // and NO "REJECTED" on stdout, which is a real regression for whatever parses that output.
  // approve-action.js now imports action-gate.js dynamically, inside its own try/catch, so
  // this must still print REJECTED and exit 1 like any other bad input.
  const approvePath = stageBrokenI18nTree({
    entryRelPath: 'hooks/lib/approve-action.js',
    copyRelPaths: ['hooks/lib/action-gate.js'],
    symlinkRelPaths: ['hooks/lib/gate-receipt.js', 'hooks/lib/locale.js'],
  });
  const stateDir = tempDir('gate-broken-i18n-approve-state-');
  const r = spawnSync(process.execPath, [approvePath, '918', '123456'], {
    encoding: 'utf8',
    env: { ...process.env, OWNMIND_GATE_STATE_DIR: stateDir },
  });
  assert.equal(r.status, 1, 'a broken i18n module fails closed, same exit code as any other rejected approval');
  assert.equal(r.stdout, 'REJECTED\n', 'must still print REJECTED on stdout, not crash with an empty stdout + stack trace');
});
