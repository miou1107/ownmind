/**
 * Tests for the hook message i18n helper: t() dictionary lookup + the OWNMIND_LOCALE_FORCE
 * seam of the getLocale() it consumes. getLocale()'s full resolution chain (account
 * preference, OS-detected locale, normalization) is covered in tests/hook-locale.test.js;
 * this file only needs the seam every t() test pins its locale through.
 *
 * Locale is pinned per test via OWNMIND_LOCALE_FORCE, the documented test-only env seam that
 * getLocale() checks first (see hooks/lib/locale.js). Two tests need a dictionary file that is
 * either missing or corrupted; both use the 'ja' locale as scratch space, since no ja.json
 * ships in this task (only zh.json and en.json do) — so there is nothing to lose by writing a
 * throwaway file there and removing it in a finally block.
 */

import { strict as assert } from 'assert';
import { test, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, resetI18nCacheForTests } from '../hooks/lib/i18n.js';
import { getLocale } from '../hooks/lib/locale.js';
import { tempDir } from './helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function localeFilePath(locale) {
  return path.join(__dirname, '..', 'hooks', 'locales', `${locale}.json`);
}

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

test('t() falls back per-key to en when the resolved dictionary is missing that key', () => {
  const jaPath = localeFilePath('ja');
  assert.equal(fs.existsSync(jaPath), false, 'precondition: ja.json must not already exist');
  fs.writeFileSync(jaPath, JSON.stringify({ 'gate.failopen': 'テスト用の文字列' }));
  try {
    process.env.OWNMIND_LOCALE_FORCE = 'ja';
    resetI18nCacheForTests();
    // Key present in ja.json comes from ja.
    assert.equal(t('gate.failopen'), 'テスト用の文字列');
    // Key absent from ja.json falls back to the en string.
    assert.equal(
      t('lint.recovered'),
      '[OwnMind] compliance checks are running again - this turn was checked'
    );
  } finally {
    fs.rmSync(jaPath, { force: true });
  }
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

test('t() does not throw when the resolved dictionary file is corrupted', () => {
  const jaPath = localeFilePath('ja');
  assert.equal(fs.existsSync(jaPath), false, 'precondition: ja.json must not already exist');
  fs.writeFileSync(jaPath, '{ this is not valid json');
  try {
    process.env.OWNMIND_LOCALE_FORCE = 'ja';
    resetI18nCacheForTests();
    assert.doesNotThrow(() => t('gate.failopen'));
    assert.equal(
      t('gate.failopen'),
      '[OwnMind] the action gate could not run - this command was NOT gated'
    );
  } finally {
    fs.rmSync(jaPath, { force: true });
  }
});

test('t() does not throw when the resolved dictionary file is missing entirely', () => {
  const jaPath = localeFilePath('ja');
  assert.equal(fs.existsSync(jaPath), false, 'precondition: ja.json must not exist for this test');
  process.env.OWNMIND_LOCALE_FORCE = 'ja';
  resetI18nCacheForTests();
  assert.doesNotThrow(() => t('gate.failopen'));
  assert.equal(
    t('gate.failopen'),
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
