/**
 * Tests for the real locale resolver (gate message i18n, task 2 of 7).
 *
 * `getLocale({ homeDir })` resolution order:
 *   1. OWNMIND_LOCALE_FORCE      — test-only seam, checked first, never touches disk.
 *   2. account preference        — `data.locale` in `<homeDir>/.ownmind/cache/memories.json`,
 *                                   honored only when it is exactly 'zh'|'en'|'ja'.
 *   3. OS-detected locale        — `detected` in `<homeDir>/.ownmind/state/locale.json`,
 *                                   normalized (/^zh/i -> zh, /^ja/i -> ja, else en).
 *   4. 'en'                      — final fallback.
 *
 * `provisionLocale({ homeDir })` is the SessionStart-only counterpart that performs OS
 * detection and writes state/locale.json; getLocale() never spawns a subprocess itself, so
 * these tests exercise the two functions independently with a temp homeDir, the same
 * isolation pattern gate-provisioning.test.js uses for the gate's state dir.
 */

import { strict as assert } from 'assert';
import { test, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tempDir } from './helpers/temp-dir.js';
import { getLocale } from '../hooks/lib/locale.js';
import { provisionLocale } from '../hooks/lib/locale-provision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const JS_HOOK = path.join(repoRoot, 'hooks', 'ownmind-session-start.js');
const SH_HOOK = path.join(repoRoot, 'hooks', 'ownmind-session-start.sh');

const ORIGINAL_FORCE = process.env.OWNMIND_LOCALE_FORCE;

beforeEach(() => {
  delete process.env.OWNMIND_LOCALE_FORCE;
});

afterEach(() => {
  if (ORIGINAL_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_FORCE;
});

function writeMemoriesCache(homeDir, data) {
  const dir = path.join(homeDir, '.ownmind', 'cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'memories.json'),
    JSON.stringify({ sync_token: 'tok', saved_at: new Date().toISOString(), data })
  );
}

function writeDetectedState(homeDir, detected) {
  const dir = path.join(homeDir, '.ownmind', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'locale.json'),
    JSON.stringify({ detected, detected_at: new Date().toISOString() })
  );
}

// --- getLocale() ---

test('getLocale prefers the account preference from the memories cache', () => {
  const home = tempDir('locale-');
  writeMemoriesCache(home, { locale: 'ja' });
  writeDetectedState(home, 'zh_TW'); // must lose to the preference
  assert.equal(getLocale({ homeDir: home }), 'ja');
});

test('getLocale falls back to the normalized OS-detected locale when no preference is stored', () => {
  const home = tempDir('locale-');
  writeDetectedState(home, 'zh_TW');
  assert.equal(getLocale({ homeDir: home }), 'zh');
});

test('getLocale normalizes an en-US detected value to en', () => {
  const home = tempDir('locale-');
  writeDetectedState(home, 'en-US');
  assert.equal(getLocale({ homeDir: home }), 'en');
});

test('getLocale normalizes a ja_JP detected value to ja', () => {
  const home = tempDir('locale-');
  writeDetectedState(home, 'ja_JP.UTF-8');
  assert.equal(getLocale({ homeDir: home }), 'ja');
});

test('getLocale returns en when both files are missing', () => {
  const home = tempDir('locale-');
  assert.equal(getLocale({ homeDir: home }), 'en');
});

test('getLocale({ homeDir: null }) degrades to the real home dir instead of throwing', () => {
  // getLocale()'s default parameter (`homeDir = os.homedir()`) only fires when the caller
  // passes `undefined` (or omits the key entirely) — an *explicit* `{ homeDir: null }` skips
  // the default and reaches `path.join(null, ...)`, which throws a TypeError. No current call
  // site passes null, but the function is documented as "sync, total (never throws)", so this
  // closes the hole rather than relying on every future caller to happen to avoid it.
  assert.doesNotThrow(() => getLocale({ homeDir: null }));
  const result = getLocale({ homeDir: null });
  assert.ok(['zh', 'en', 'ja'].includes(result), `expected a valid locale, got ${JSON.stringify(result)}`);
});

test('getLocale(null) degrades instead of throwing (the same hole, one level up)', () => {
  // Fix round 2. The previous round closed `{ homeDir: null }` but left the parameter itself
  // as `({ homeDir = os.homedir() } = {})`, whose `= {}` default also only fires for
  // `undefined` — so an explicit `getLocale(null)` destructures null and throws before any of
  // the inner guarding runs. Same reasoning, one level up, and the function is documented as
  // total, so it has to hold for every argument rather than for the shapes we happened to
  // think of.
  assert.doesNotThrow(() => getLocale(null));
  assert.ok(['zh', 'en', 'ja'].includes(getLocale(null)));
  // `false` / `0` / `''` reach the same path; pinned so a future `opts ?? {}` (which would
  // let `false` through to the destructuring) cannot silently reopen it.
  for (const falsy of [undefined, null, false, 0, '']) {
    assert.doesNotThrow(() => getLocale(falsy), `getLocale(${JSON.stringify(falsy)}) must not throw`);
  }
});

test('getLocale returns en when both files are garbage/corrupted', () => {
  const home = tempDir('locale-');
  const cacheDir = path.join(home, '.ownmind', 'cache');
  const stateDir = path.join(home, '.ownmind', 'state');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'memories.json'), '{ not json');
  fs.writeFileSync(path.join(stateDir, 'locale.json'), '{ also not json');
  assert.equal(getLocale({ homeDir: home }), 'en');
});

test('getLocale ignores an invalid stored preference and falls through to detected state', () => {
  const home = tempDir('locale-');
  writeMemoriesCache(home, { locale: 'fr' }); // not one of zh|en|ja — must be ignored
  writeDetectedState(home, 'zh_TW');
  assert.equal(getLocale({ homeDir: home }), 'zh');
});

test('getLocale tolerates a memories cache with no data.locale at all (pre-Task-5 shape)', () => {
  const home = tempDir('locale-');
  writeMemoriesCache(home, {}); // data present, but no .locale key yet
  writeDetectedState(home, 'ja_JP');
  assert.equal(getLocale({ homeDir: home }), 'ja');
});

test('OWNMIND_LOCALE_FORCE overrides both the preference and the detected state', () => {
  const home = tempDir('locale-');
  writeMemoriesCache(home, { locale: 'ja' });
  writeDetectedState(home, 'zh_TW');
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  assert.equal(getLocale({ homeDir: home }), 'zh');
});

test('OWNMIND_LOCALE_FORCE with an unsupported value is ignored (falls through the chain)', () => {
  const home = tempDir('locale-');
  writeDetectedState(home, 'ja_JP');
  process.env.OWNMIND_LOCALE_FORCE = 'fr';
  assert.equal(getLocale({ homeDir: home }), 'ja');
});

// --- provisionLocale() ---

test('provisionLocale writes valid JSON with detected and detected_at', () => {
  const home = tempDir('locale-prov-');
  provisionLocale({ homeDir: home });
  const p = path.join(home, '.ownmind', 'state', 'locale.json');
  assert.ok(fs.existsSync(p), 'locale.json must be written');
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok('detected' in parsed);
  assert.ok(typeof parsed.detected === 'string' || parsed.detected === null);
  assert.match(parsed.detected_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    'detected_at must be an ISO timestamp');
});

test('provisionLocale writes detected: null and does not throw when the OS detector fails', () => {
  const home = tempDir('locale-prov-');
  // Force the platform branch to one whose binary does not exist on this test machine, so
  // the underlying execFileSync throws for real rather than via a mocked seam.
  const originalPlatform = process.platform;
  const missingBinaryPlatform = originalPlatform === 'win32' ? 'darwin' : 'win32';
  Object.defineProperty(process, 'platform', { value: missingBinaryPlatform, configurable: true });
  try {
    assert.doesNotThrow(() => provisionLocale({ homeDir: home }));
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  }
  const p = path.join(home, '.ownmind', 'state', 'locale.json');
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(parsed.detected, null);
  assert.match(parsed.detected_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

/**
 * Fix round 2 — the OS detector must not leak the child's stderr into the parent's.
 *
 * `execFileSync` without an explicit `stdio` pipes the child's stderr straight to the parent
 * process's stderr (Node documents exactly this default). On macOS/Linux the `.sh` SessionStart
 * twin redirects the whole provisioning step, so nothing shows; but a Windows install runs the
 * `.js` twin, where `provisionLocale()` executes IN-PROCESS
 * (hooks/ownmind-session-start.js) — so whatever `powershell.exe` writes to stderr
 * (Constrained Language Mode, AppLocker/WDAC, execution-policy errors) lands on the hook's own
 * stderr, which in this product is a channel the user reads.
 *
 * The assertion is platform-independent even though the incident is Windows-only: it forces
 * the darwin branch (the one whose detector is a plain executable that can be shimmed on PATH)
 * and proves the parent's stderr stays clean while the state file is still written. Skipped on
 * win32, where a PATH shim cannot stand in for `powershell.exe` without a shell.
 */
test('the OS detector never writes to the parent process stderr', { skip: process.platform === 'win32' }, () => {
  const home = tempDir('locale-prov-stderr-');
  const binDir = path.join(home, 'shim-bin');
  fs.mkdirSync(binDir, { recursive: true });

  // Stands in for a locked-down `powershell.exe`: noisy on stderr, non-zero exit.
  const shim = path.join(binDir, 'defaults');
  fs.writeFileSync(shim,
    '#!/bin/sh\n'
    + 'echo "PSSecurityException: cannot be loaded because running scripts is disabled" >&2\n'
    + 'echo "At line:1 char:1" >&2\n'
    + 'exit 1\n');
  fs.chmodSync(shim, 0o755);

  const runner = path.join(home, 'run-provision.mjs');
  fs.writeFileSync(runner,
    `import { provisionLocale } from ${JSON.stringify(path.join(repoRoot, 'hooks', 'lib', 'locale-provision.js'))};\n`
    // The darwin branch is the one with a shimmable executable detector; forcing it keeps
    // this test meaningful on Linux CI too (where the real branch reads $LANG and spawns
    // nothing at all).
    + "Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });\n"
    + `provisionLocale({ homeDir: ${JSON.stringify(home)} });\n`);

  const r = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });

  assert.equal(r.status, 0, `the runner must exit 0 (stderr: ${r.stderr})`);
  assert.equal(r.stderr, '',
    `the detector's stderr must never reach the parent process — got: ${JSON.stringify(r.stderr)}`);

  // ...and the failure still degrades to a well-formed state file, exactly as before.
  const p = path.join(home, '.ownmind', 'state', 'locale.json');
  assert.ok(fs.existsSync(p), 'locale.json must still be written when the detector fails');
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(parsed.detected, null);
  assert.match(parsed.detected_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('provisionLocale never throws even when the state dir cannot be created', () => {
  // A homeDir that is actually a file (not a directory) makes mkdirSync fail.
  const home = tempDir('locale-prov-blocked-');
  const blockedHome = path.join(home, 'not-a-dir');
  fs.writeFileSync(blockedHome, 'i am a file, not a directory');
  assert.doesNotThrow(() => provisionLocale({ homeDir: blockedHome }));
});

// --- SessionStart wiring: both hook twins actually call provisionLocale() ---

function hookEnv(home) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OWNMIND_API_URL: 'http://127.0.0.1:1',
    OWNMIND_API_KEY: '00000000-0000-4000-8000-000000000000',
  };
  delete env.OWNMIND_GATE_STATE_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

const payload = JSON.stringify({ session_id: 'locale-wire-1', hook_event_name: 'SessionStart', source: 'startup' });

test('the .js SessionStart hook provisions state/locale.json', () => {
  const home = tempDir('locale-wire-js-');
  const r = spawnSync(process.execPath, [JS_HOOK], {
    encoding: 'utf8', input: payload, env: hookEnv(home), timeout: 30000,
  });
  assert.equal(r.status, 0, `hook must exit 0 (stderr: ${r.stderr})`);
  const p = path.join(home, '.ownmind', 'state', 'locale.json');
  assert.ok(fs.existsSync(p), 'locale.json must exist after session start');
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok('detected' in parsed);
  assert.match(parsed.detected_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('the .sh SessionStart hook provisions state/locale.json', { skip: process.platform === 'win32' }, () => {
  const home = tempDir('locale-wire-sh-');
  const r = spawnSync('bash', [SH_HOOK], {
    encoding: 'utf8', input: payload, env: hookEnv(home), timeout: 30000,
  });
  assert.equal(r.status, 0, `hook must exit 0 (stderr: ${r.stderr})`);
  const p = path.join(home, '.ownmind', 'state', 'locale.json');
  assert.ok(fs.existsSync(p), 'locale.json must exist after a .sh session start');
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok('detected' in parsed);
  assert.match(parsed.detected_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('a locale-provision.js failure never breaks SessionStart (fire-and-forget)', () => {
  // Everything under HOME is a normal, writable directory except .ownmind/state itself,
  // which is a plain file — so mkdirSync(stateDir, {recursive:true}) fails inside
  // provisionLocale() (and provisionGateSession(), which shares the same path) specifically,
  // without breaking unrelated HOME-rooted paths like the log directory. The hook must still
  // exit 0.
  const home = tempDir('locale-wire-fail-');
  fs.mkdirSync(path.join(home, '.ownmind'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ownmind', 'state'), 'not a directory');
  const r = spawnSync(process.execPath, [JS_HOOK], {
    encoding: 'utf8', input: payload, env: hookEnv(home), timeout: 30000,
  });
  assert.equal(r.status, 0, `hook must still exit 0 even when locale provisioning cannot write (stderr: ${r.stderr})`);
});
