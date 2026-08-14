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
