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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    '[OwnMind] 🟢 AI 想做一件你規定要先問過的事，OwnMind 先擋住了：compose no-cache\n'
    + '  你回「go」，OwnMind 就放行這一次；回「no」就不准。'
  );
});

test('zh: code-mode ask userLine (action variant)', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const dir = prepStateDir();
  const g = mkGuard({ id: 701, ask_first: true, checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(ask.kind, 'ask');
  const code = ask.userLine.match(/放行這一次：(\d{6})/)?.[1];
  assert.ok(code, 'a 6-digit code must be present');
  assert.equal(
    ask.userLine,
    '[OwnMind] 🟢 AI 想做一件你規定要先問過的事，OwnMind 先擋住了：compose no-cache\n'
    + `  你把這組數字貼給 AI，OwnMind 就放行這一次：${code}`
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
  const code = limit.userLine.match(/放行這一次：(\d{6})/)?.[1];
  assert.ok(code, 'a 6-digit code must be present');
  assert.equal(
    limit.userLine,
    '[OwnMind] 🟡 AI 同一個指令被 OwnMind 擋了 3 次還在試，卡在這條規矩上：compose no-cache\n'
    + `  你把這組數字貼給 AI，OwnMind 就放行這一次：${code}；不想放行就不用理它。`
  );
});

test('zh: read-block userLine', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const dir = prepStateDir();
  const g = mkGuard({ id: 703 });
  const r = evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(r.kind, 'read');
  assert.equal(r.userLine, '[OwnMind] 🟢 AI 還沒讀過這條規矩就想動手，OwnMind 擋下來了：compose no-cache\n'
    + '  AI 讀完再試一次，OwnMind 就會自動放行，你不用做什麼。');
});

test('zh: check-block userLine', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const dir = prepStateDir();
  const g = mkGuard({ id: 704 });
  evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' }); // consume read
  const r = evaluateGate({ command: 'docker compose build api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(r.kind, 'check');
  assert.equal(r.userLine, '[OwnMind] 🟢 AI 的指令不符合你的規矩，OwnMind 擋下來了：add --no-cache (IR-018)\n'
    + '  AI 改對再試一次就會過，你不用做什麼。');
});

// --- en regression pin: byte-identical to the pre-change literals (string-inventory.json) ---

test('en: verbal-mode ask userLine is byte-identical to the pre-change literal', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const dir = prepStateDir();
  const g = mkGuard({ id: 710, ask_first: true, ask_mode: 'verbal', checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(
    ask.userLine,
    '[OwnMind] 🟢 The AI wants to do something your rules say to ask about first, so OwnMind stopped it: compose no-cache\n'
    + '  Reply "go" and OwnMind allows it this once; reply "no" and it does not.'
  );
});

test('en: code-mode ask userLine is byte-identical to the pre-change literal', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const dir = prepStateDir();
  const g = mkGuard({ id: 711, ask_first: true, checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  const code = ask.userLine.match(/allows it this once: (\d{6})/)?.[1];
  assert.ok(code, 'a 6-digit code must be present');
  assert.equal(
    ask.userLine,
    '[OwnMind] 🟢 The AI wants to do something your rules say to ask about first, so OwnMind stopped it: compose no-cache\n'
    + `  Paste this number to the AI and OwnMind allows it this once: ${code}`
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
  const code = limit.userLine.match(/allows it this once: (\d{6})/)?.[1];
  assert.ok(code, 'a 6-digit code must be present');
  assert.equal(
    limit.userLine,
    '[OwnMind] 🟡 OwnMind has blocked the same command from the AI 3 times and it is still trying. It is stuck on this rule: compose no-cache\n'
    + `  Paste this number to the AI and OwnMind allows it this once: ${code}. If you would rather it stopped, just ignore this.`
  );
});

test('en: read-block userLine is byte-identical to the pre-change literal', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const dir = prepStateDir();
  const g = mkGuard({ id: 713 });
  const r = evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(
    r.userLine,
    '[OwnMind] 🟢 The AI tried to act without reading this rule first, so OwnMind stopped it: compose no-cache\n'
    + '  Once the AI has read the rule and retried, OwnMind lets it through automatically. Nothing for you to do.'
  );
});

test('en: check-block userLine is byte-identical to the pre-change literal', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const dir = prepStateDir();
  const g = mkGuard({ id: 714 });
  evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  const r = evaluateGate({ command: 'docker compose build api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(
    r.userLine,
    "[OwnMind] 🟢 The AI's command does not meet your rules, so OwnMind stopped it: add --no-cache (IR-018)\n"
    + '  Once the AI fixes the command and retries it will go through. Nothing for you to do.'
  );
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
    systemMessage: '[OwnMind] 🟡 OwnMind 這次無法確認 AI 有沒有讀過規矩，但還是照你的規矩在擋 AI 的指令。',
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
    systemMessage: '[OwnMind] 🔴 OwnMind 這次沒能檢查 AI 這個指令，它就直接跑掉了。要緊的話，你自己看一下它做了什麼。',
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
    systemMessage: '[OwnMind] 🔴 OwnMind 這次沒能檢查 AI 這個指令，它就直接跑掉了。要緊的話，你自己看一下它做了什麼。',
  });
});

// --- A broken i18n module must never crash a gate entry point, and must never change what
// the gate DECIDES. The message layer is formatting, not enforcement: whatever is wrong with
// it, the block still has to happen and the user still has to get a readable English line. ---

/**
 * The four ways the message layer can be broken on a real machine, each staged as a different
 * hooks/lib/i18n.js (or the absence of one). An interrupted update.sh, a failed copy, or a
 * Windows AV quarantine produce these, and none of them may switch the gate off.
 *
 *   brokenSyntax        the file exists but does not parse — `import()` REJECTS. Proves the
 *                       guard wraps the import itself, not just a well-formed-but-empty module.
 *   absent              the file is simply not there (ERR_MODULE_NOT_FOUND).
 *   throwing            it loads and exports a `t`, but every call throws — a load-time guard
 *                       alone does not survive this one; the call site must be guarded too.
 *   realWithoutLocales  the real module, staged with NO hooks/locales/ beside it. Nothing
 *                       throws here: t() finds no dictionary and echoes the KEY back. A raw
 *                       key is not a message either, so this must fall back the same way.
 */
const I18N_VARIANTS = {
  brokenSyntax: { label: 'unparseable', write: 'export function t( { this is not valid js' },
  absent: { label: 'missing', write: null },
  throwing: {
    label: 'throwing',
    write: "export function t() { throw new Error('i18n exploded'); }\n"
      + 'export function resetI18nCacheForTests() {}\n',
  },
  realWithoutLocales: { label: 'dictionary-less', copyReal: true },
};

/**
 * Stages an isolated directory carrying one of the I18N_VARIANTS above, with everything else
 * needed to load `entryRelPath` present too. `copyRelPaths` are real file-CONTENT copies (for
 * files whose OWN `./i18n.js`-relative resolution must land on the staged one — i.e.
 * hooks/lib/action-gate.js and the entry file itself); `symlinkRelPaths` are symlinks to the
 * real files (for everything else on the import graph that just needs to load, where
 * redirecting its own further imports does not matter).
 *
 * These must be real copies, not symlinks, for the two files named above: Node's ESM loader
 * resolves a symlinked module's `import.meta.url` to its REAL path by default (verified
 * empirically — see task report), so a symlinked action-gate.js would resolve its own
 * `./i18n.js` against the real repo path and silently load the real, working i18n.js instead
 * of this staged one. `shared/` is always safe to symlink whole, because none of the files
 * under it have relative imports of their own that need mis-resolving.
 *
 * Never touches the real hooks/lib/i18n.js — every other test file in this suite transitively
 * imports it through the gate, so corrupting the real one, even briefly, would be a
 * shared-file race against every other test file node's parallel test runner may run
 * concurrently.
 */
function stageGateTree({ entryRelPath, copyRelPaths = [], symlinkRelPaths = [], variant = I18N_VARIANTS.brokenSyntax }) {
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
  const stagedI18n = path.join(tempRoot, 'hooks', 'lib', 'i18n.js');
  if (variant.copyReal) {
    // A copy, not a symlink, for the same import.meta.url reason as above: the staged copy must
    // resolve `../locales/` against THIS tree (which has none), not against the real repo.
    fs.copyFileSync(path.join(repoRoot, 'hooks', 'lib', 'i18n.js'), stagedI18n);
  } else if (variant.write !== null) {
    fs.writeFileSync(stagedI18n, variant.write);
  }
  return path.join(tempRoot, entryRelPath);
}

// The exact English literals the gate emitted before any of this branch existed (byte-identical
// to hooks/locales/en.json, which tests above pin against the pre-change template literals).
const EN_READ_BLOCK = '[OwnMind] 🟢 The AI tried to act without reading this rule first, so OwnMind stopped it: compose no-cache\n'
  + '  Once the AI has read the rule and retried, OwnMind lets it through automatically. Nothing for you to do.';
const EN_CHECK_BLOCK = "[OwnMind] 🟢 The AI's command does not meet your rules, so OwnMind stopped it: add --no-cache (IR-018)\n"
  + '  Once the AI fixes the command and retries it will go through. Nothing for you to do.';
const EN_VERBAL_ASK = '[OwnMind] 🟢 The AI wants to do something your rules say to ask about first, so OwnMind stopped it: compose no-cache\n'
    + '  Reply "go" and OwnMind allows it this once; reply "no" and it does not.';

/** Loads an isolated copy of action-gate.js whose `./i18n.js` is the given broken variant. */
async function loadGateWith(variant) {
  const gatePath = stageGateTree({
    entryRelPath: 'hooks/lib/action-gate.js',
    symlinkRelPaths: ['hooks/lib/gate-receipt.js', 'hooks/lib/locale.js'],
    variant,
  });
  return import(pathToFileURL(gatePath).href);
}

for (const [name, variant] of Object.entries(I18N_VARIANTS)) {
  test(`evaluateGate: a ${variant.label} i18n.js (${name}) still BLOCKS, with the English userLine`, async () => {
    // zh is forced on purpose: a working message layer would answer in Chinese here, so an
    // English line proves the fallback fired rather than the dictionary being consulted.
    process.env.OWNMIND_LOCALE_FORCE = 'zh';
    const broken = await loadGateWith(variant);

    const dir = prepStateDir();
    const g = mkGuard({ id: 760 });

    const readBlock = broken.evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
    assert.equal(readBlock.action, 'block', 'the read gate must still block');
    assert.equal(readBlock.kind, 'read');
    assert.equal(readBlock.userLine, EN_READ_BLOCK);

    const checkBlock = broken.evaluateGate({ command: 'docker compose build api', guards: [g], stateDir: dir, sessionId: 's1' });
    assert.equal(checkBlock.action, 'block', 'the compliance check must still block');
    assert.equal(checkBlock.kind, 'check');
    assert.equal(checkBlock.userLine, EN_CHECK_BLOCK);

    const askDir = prepStateDir();
    const verbalGuard = mkGuard({ id: 761, ask_first: true, ask_mode: 'verbal', checks: [], read_required: false });
    const verbalAsk = broken.evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [verbalGuard], stateDir: askDir, sessionId: 's1' });
    assert.equal(verbalAsk.action, 'block', 'the verbal ask must still block');
    assert.equal(verbalAsk.kind, 'ask');
    assert.equal(verbalAsk.userLine, EN_VERBAL_ASK);

    const codeDir = prepStateDir();
    const codeGuard = mkGuard({ id: 762, ask_first: true, checks: [], read_required: false });
    const codeAsk = broken.evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [codeGuard], stateDir: codeDir, sessionId: 's1' });
    assert.equal(codeAsk.action, 'block', 'the code ask must still block');
    const code = codeAsk.userLine.match(/allows it this once: (\d{6})/)?.[1];
    assert.ok(code, `a 6-digit code must still reach the user, got: ${JSON.stringify(codeAsk.userLine)}`);
    assert.equal(
      codeAsk.userLine,
      '[OwnMind] 🟢 The AI wants to do something your rules say to ask about first, so OwnMind stopped it: compose no-cache\n'
    + `  Paste this number to the AI and OwnMind allows it this once: ${code}`
    );

    // Belt and braces on the two failure shapes a naive fallback would produce anyway.
    for (const line of [readBlock.userLine, checkBlock.userLine, verbalAsk.userLine, codeAsk.userLine]) {
      assert.ok(line, 'a block notice must never be empty');
      assert.ok(!/^gate\.[a-z.]+$/.test(line), `a raw dictionary key must never reach the user, got: ${line}`);
    }
  });
}

test('evaluateGate: a broken i18n.js changes only userLine — action/kind/reason/guardId match the intact module', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const broken = await loadGateWith(I18N_VARIANTS.brokenSyntax);

  for (const command of ['docker compose build --no-cache api', 'docker compose build api']) {
    const intactDir = prepStateDir();
    const brokenDir = prepStateDir();
    const g = () => mkGuard({ id: 763 });
    // Same sequence on both so the read receipt state lines up.
    const intact = evaluateGate({ command, guards: [g()], stateDir: intactDir, sessionId: 's1' });
    const degraded = broken.evaluateGate({ command, guards: [g()], stateDir: brokenDir, sessionId: 's1' });
    assert.equal(degraded.action, intact.action);
    assert.equal(degraded.kind, intact.kind);
    assert.equal(degraded.guardId, intact.guardId);
    assert.equal(degraded.reason, intact.reason, 'the model-facing reason never depended on i18n and must not start now');
  }
});

test('CLI end-to-end: an unloadable i18n.js still emits the BLOCK decision, with the English notice', () => {
  const cliPath = stageGateTree({
    entryRelPath: 'hooks/lib/action-gate-cli.js',
    copyRelPaths: ['hooks/lib/action-gate.js'],
    symlinkRelPaths: ['hooks/lib/gate-receipt.js', 'hooks/lib/enforcement-cache.js', 'hooks/lib/locale.js'],
  });
  const home = tempDir('gate-broken-i18n-home-');
  stageEnforcement(home, [mkGuard({ id: 750 })]);

  const payload = JSON.stringify({
    session_id: 'broken-i18n', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'docker compose build --no-cache api' }, // read-blocks
  });
  const r = spawnSync(process.execPath, [cliPath], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, OWNMIND_LOCALE_FORCE: 'zh' },
  });
  assert.equal(r.status, 0, `must exit 0 even with a broken i18n module; stderr=${r.stderr.slice(0, 500)}`);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); }, `stdout must be valid JSON, got:\n${r.stdout}`);
  // The whole point of the fix: a broken message layer may not turn the gate off.
  assert.equal(parsed.decision, 'block', 'a broken i18n module must NOT fail the gate open');
  assert.match(parsed.reason, /Read this rule before acting/);
  assert.equal(
    parsed.systemMessage,
    EN_READ_BLOCK,
    'the fallback is the plain English literal even though OWNMIND_LOCALE_FORCE=zh was set — i18n itself is broken'
  );
});

test('JS hook end-to-end: an unloadable i18n.js still emits the BLOCK decision, with the English notice', () => {
  // The .js hook's static import list is longer than the CLI's, but only action-gate.js and
  // the entry file itself sit on the path to i18n.js — everything else here just needs to
  // load, so it is symlinked to the real (unbroken) file rather than copied.
  const hookPath = stageGateTree({
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
  assert.equal(parsed.decision, 'block', 'a broken i18n module must NOT fail the gate open');
  assert.match(parsed.reason, /Read this rule before acting/);
  assert.equal(
    parsed.systemMessage,
    EN_READ_BLOCK,
    'the fallback is the plain English literal even though OWNMIND_LOCALE_FORCE=zh was set — i18n itself is broken'
  );
});

test('approve-action CLI: an unloadable i18n.js still prints REJECTED (not a crash with empty stdout)', () => {
  // Regression case: approve-action.js statically imports action-gate.js at its own top level —
  // a location that cannot be wrapped in try/catch. When action-gate.js in turn held a STATIC
  // `import { t } from './i18n.js'`, a broken i18n.js crashed approve-action.js with a raw
  // stack trace and NO "REJECTED" on stdout, which is a real regression for whatever parses
  // that output. approve-action.js now imports action-gate.js dynamically, inside its own
  // try/catch, and action-gate.js's own i18n import is guarded — so this must still print
  // REJECTED and exit 1 like any other bad input.
  const approvePath = stageGateTree({
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
