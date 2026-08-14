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

// --- CLI: a totally broken i18n module must never crash the gate or change its decision —
// it must fall back to the plain English literal, exactly as if i18n.js did not exist ---

/**
 * Stages an isolated copy of the CLI's own import chain (action-gate.js, gate-receipt.js,
 * enforcement-cache.js, locale.js — everything action-gate-cli.js's dynamic imports touch)
 * with real file CONTENT copied in, EXCEPT hooks/lib/i18n.js, which is replaced with a file
 * that fails to parse. This simulates "the i18n module cannot load" without ever touching the
 * real hooks/lib/i18n.js — every other test file in this suite (after Task 3) transitively
 * imports that file through the gate, so corrupting the real one, even briefly, would be a
 * shared-file race against every other test file node's parallel test runner may run
 * concurrently.
 *
 * These must be real copies, not symlinks: Node's ESM loader resolves a symlinked module's
 * `import.meta.url` to its REAL path by default (verified empirically — see task report), so
 * a symlinked action-gate.js would resolve its own `./i18n.js` against the real repo path and
 * silently load the real, working i18n.js instead of this staged broken one. Only `shared/`
 * is safe to symlink whole, because shared/helpers.js has no relative imports of its own to
 * mis-resolve.
 */
function stageBrokenI18nCli() {
  const tempRoot = tempDir('gate-broken-i18n-');
  fs.mkdirSync(path.join(tempRoot, 'hooks', 'lib'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'shared'), path.join(tempRoot, 'shared'));
  const KEEP = ['action-gate-cli.js', 'action-gate.js', 'gate-receipt.js', 'enforcement-cache.js', 'locale.js'];
  for (const name of KEEP) {
    fs.copyFileSync(path.join(repoRoot, 'hooks', 'lib', name), path.join(tempRoot, 'hooks', 'lib', name));
  }
  // A syntax error: the dynamic `import('./i18n.js')` this simulates must REJECT, not just
  // return something t()-shaped, to prove the guard around the import itself (not just around
  // a well-formed-but-empty module).
  fs.writeFileSync(path.join(tempRoot, 'hooks', 'lib', 'i18n.js'), 'export function t( { this is not valid js');
  return path.join(tempRoot, 'hooks', 'lib', 'action-gate-cli.js');
}

test('CLI: an unloadable i18n.js falls back to the English literal, exits 0, and fails the command open', () => {
  const cliPath = stageBrokenI18nCli();
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
