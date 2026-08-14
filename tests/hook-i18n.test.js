/**
 * Tests for the hook message i18n helper: t() dictionary lookup + the OWNMIND_LOCALE_FORCE
 * seam of the getLocale() it consumes. getLocale()'s full resolution chain (account
 * preference, OS-detected locale, normalization) is covered in tests/hook-locale.test.js;
 * this file only needs the seam every t() test pins its locale through.
 *
 * Locale is pinned per test via OWNMIND_LOCALE_FORCE, the documented test-only env seam that
 * getLocale() checks first (see hooks/lib/locale.js).
 *
 * hooks/locales/ja.json shipped for real as of Task 6 (gate-message-i18n) — before that, this
 * file used the 'ja' locale as scratch space for a missing/corrupt/partial dictionary, since
 * nothing shipped there yet. Now that the real file exists and every other suite (notably
 * tests/hook-locales-parity.test.js) reads it, writing to or deleting the real
 * hooks/locales/ja.json here would race whichever other test file node's parallel test runner
 * happens to schedule alongside this one. The three tests below instead stage a private copy
 * of i18n.js + locale.js under a throwaway hooks/lib/, next to a throwaway hooks/locales/
 * carrying only the fixture files each test needs — never touching the real committed tree.
 * i18n.js resolves its dictionary path relative to its own file
 * (`new URL('../locales/...', import.meta.url)`), so a *copy* is required, not a symlink:
 * Node's ESM loader resolves a symlinked module back to the real file's path by default, which
 * would defeat the isolation. Real en.json and zh.json are copied in too, since t()'s fallback
 * chain always tries `en` after the forced locale, and the fallback assertions below pin real
 * production English strings.
 */

import { strict as assert } from 'assert';
import { test, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { t, resetI18nCacheForTests } from '../hooks/lib/i18n.js';
import { getLocale } from '../hooks/lib/locale.js';
import { tempDir } from './helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const ORIGINAL_FORCE = process.env.OWNMIND_LOCALE_FORCE;

beforeEach(() => {
  resetI18nCacheForTests();
});

afterEach(() => {
  resetI18nCacheForTests();
  if (ORIGINAL_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_FORCE;
});

test('t() returns the en string for a known key when locale is en', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  assert.equal(
    t('gate.failopen'),
    '[OwnMind] the action gate could not run - this command was NOT gated'
  );
});

test('t() returns the zh string when locale resolves to zh', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  assert.equal(
    t('gate.failopen'),
    '[OwnMind] 閘門這次沒跑起來，這個指令「沒有」被把關'
  );
});

/**
 * Stages a private copy of hooks/lib/i18n.js + locale.js under a scratch directory, with a
 * scratch hooks/locales/ carrying real en.json/zh.json plus whatever `ja.json` content the
 * caller supplies (a string to write it verbatim, or omitted entirely to leave `ja.json`
 * absent from the scratch tree). Returns the staged i18n.js's file:// URL, ready to `import()`.
 */
function stageI18nForJaFixture(jaJsonContent) {
  const tempRoot = tempDir('hook-i18n-scratch-');
  const libDir = path.join(tempRoot, 'hooks', 'lib');
  const localesDir = path.join(tempRoot, 'hooks', 'locales');
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(localesDir, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'hooks', 'lib', 'i18n.js'), path.join(libDir, 'i18n.js'));
  fs.copyFileSync(path.join(repoRoot, 'hooks', 'lib', 'locale.js'), path.join(libDir, 'locale.js'));
  fs.copyFileSync(path.join(repoRoot, 'hooks', 'locales', 'en.json'), path.join(localesDir, 'en.json'));
  fs.copyFileSync(path.join(repoRoot, 'hooks', 'locales', 'zh.json'), path.join(localesDir, 'zh.json'));
  if (jaJsonContent !== undefined) {
    fs.writeFileSync(path.join(localesDir, 'ja.json'), jaJsonContent);
  }
  return pathToFileURL(path.join(libDir, 'i18n.js')).href;
}

test('t() falls back per-key to en when the resolved dictionary is missing that key', async () => {
  const mod = await import(stageI18nForJaFixture(JSON.stringify({ 'gate.failopen': 'テスト用の文字列' })));
  process.env.OWNMIND_LOCALE_FORCE = 'ja';
  // Key present in the staged ja.json comes from ja.
  assert.equal(mod.t('gate.failopen'), 'テスト用の文字列');
  // Key absent from the staged ja.json falls back to the en string.
  assert.equal(
    mod.t('lint.recovered'),
    '[OwnMind] compliance checks are running again - this turn was checked'
  );
});

test('t() returns the key itself when missing from every dictionary', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  assert.equal(t('nonexistent.key.for.test'), 'nonexistent.key.for.test');
});

test('t() substitutes {title} and {code} placeholders', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const out = t('gate.ask.code.action', { title: 'Deploy prod', code: '123456' });
  assert.equal(
    out,
    '[OwnMind] ⛔ "Deploy prod" wants your approval for: this action. Approval code: 123456 (paste it to the AI to allow it once)'
  );
});

test('t() leaves unknown/unsupplied placeholders as-is', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const out = t('gate.check.blocked', {});
  assert.equal(out, '[OwnMind] ⛔ blocked: {reason}');
});

test('t() does not throw when the resolved dictionary file is corrupted', async () => {
  const mod = await import(stageI18nForJaFixture('{ this is not valid json'));
  process.env.OWNMIND_LOCALE_FORCE = 'ja';
  assert.doesNotThrow(() => mod.t('gate.failopen'));
  assert.equal(
    mod.t('gate.failopen'),
    '[OwnMind] the action gate could not run - this command was NOT gated'
  );
});

test('t() does not throw when the resolved dictionary file is missing entirely', async () => {
  const mod = await import(stageI18nForJaFixture());
  process.env.OWNMIND_LOCALE_FORCE = 'ja';
  assert.doesNotThrow(() => mod.t('gate.failopen'));
  assert.equal(
    mod.t('gate.failopen'),
    '[OwnMind] the action gate could not run - this command was NOT gated'
  );
});

test('getLocale honors OWNMIND_LOCALE_FORCE for valid locale codes', () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  assert.equal(getLocale(), 'zh');
  process.env.OWNMIND_LOCALE_FORCE = 'ja';
  assert.equal(getLocale(), 'ja');
});

test('getLocale falls back to en when OWNMIND_LOCALE_FORCE is unset or invalid', () => {
  // Task 2 replaced the stub with real resolution, which reads
  // <homeDir>/.ownmind/{cache/memories.json,state/locale.json}. Point it at an empty temp
  // dir so this stays a pure OWNMIND_LOCALE_FORCE test rather than depending on whatever
  // account preference or OS-detected locale happens to be on the machine running the suite
  // (see tests/hook-locale.test.js for the real-resolution cases this task added).
  const home = tempDir('hook-i18n-locale-');
  delete process.env.OWNMIND_LOCALE_FORCE;
  assert.equal(getLocale({ homeDir: home }), 'en');
  process.env.OWNMIND_LOCALE_FORCE = 'fr';
  assert.equal(getLocale({ homeDir: home }), 'en');
});
