#!/usr/bin/env node
'use strict';
/**
 * The installer's ASK: / FIX: / NEXT: lines, in the colleague's language.
 *
 * The AI that runs the installer reads these lines. `ASK:<code>:<sentence>` carries a sentence
 * the AI relays to the person at the keyboard, so the sentence is already in that person's
 * language (zh / ja / en, English when the language is unknown). `FIX:<code>:<command>` and
 * `NEXT:<kind>[:<detail>]` are for the AI itself and are never translated.
 *
 * Sentences live in hooks/locales/<lang>.json under install.*; this file only looks them up.
 * The shell and PowerShell scripts call the command line form when a node exists, and print
 * their own English literal otherwise (bootstrap runs before any node is on the machine).
 * tests/install-messages.test.js pins those literals to en.json.
 *
 * Command line:
 *   node install-messages.cjs ask <code> [--locale xx]     -> ASK:<code>:<sentence>
 *   node install-messages.cjs say <dictionary key> [--locale xx]  -> the bare sentence
 *   node install-messages.cjs next <kind> [detail]         -> NEXT:<kind>[:<detail>]
 *   node install-messages.cjs fix <code> <command>         -> FIX:<code>:<command>
 * Exit code 1 and nothing on stdout when the code or key is unknown, so a caller falls back
 * to its literal.
 *
 * Written as CommonJS and without any dependency: it runs on whatever Node the machine has
 * (the check that the Node is new enough comes later in the install).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LOCALES_DIR = path.join(__dirname, '..', '..', 'hooks', 'locales');
const SUPPORTED = new Set(['zh', 'en', 'ja']);

function loadDictionary(lang) {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${lang}.json`), 'utf8'));
  } catch {
    return {};
  }
}

/** zh_TW, zh-Hant, ja_JP.UTF-8, en-US ... to zh / ja / en; null for an empty value or C / POSIX. */
function normalizeLocale(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || /^(c|posix)(\.|$)/i.test(value)) return null;
  if (/^zh/i.test(value)) return 'zh';
  if (/^ja/i.test(value)) return 'ja';
  return 'en';
}

/**
 * The language of the person at this computer. OWNMIND_LOCALE_FORCE first (tests), then
 * LC_ALL / LANG, then on a Mac the system language (a desktop app often starts its children
 * without LANG), then the locale a session hook saved earlier, then English.
 * @param {Record<string,string|undefined>} [env]
 * @param {{ skipSystem?: boolean, homeDir?: string }} [options] skipSystem leaves out the
 *   Mac lookup and the saved file, for tests that must not depend on the developer's machine.
 */
function detectLocale(env = process.env, options = {}) {
  const forced = env.OWNMIND_LOCALE_FORCE;
  if (SUPPORTED.has(forced)) return forced;
  const fromEnv = normalizeLocale(env.LC_ALL) || normalizeLocale(env.LANG);
  if (fromEnv) return fromEnv;
  if (options.skipSystem) return 'en';
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('defaults', ['read', '-g', 'AppleLocale'], {
        timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      const found = normalizeLocale(raw);
      if (found) return found;
    } catch { /* no answer: carry on */ }
  }
  try {
    const home = options.homeDir || os.homedir();
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.ownmind', 'state', 'locale.json'), 'utf8'));
    const found = normalizeLocale(saved && saved.detected);
    if (found) return found;
  } catch { /* nothing saved */ }
  return 'en';
}

/**
 * One dictionary value is one line of installer output: a line break inside it would end the
 * ASK or NEXT line early and leave the rest of the sentence as a stray line.
 */
function flat(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

/** One dictionary value in `locale`, in English when that language lacks the key; null when no language has it. */
function lookup(key, locale) {
  const lang = SUPPORTED.has(locale) ? locale : 'en';
  const own = loadDictionary(lang)[key];
  if (typeof own === 'string' && own) return flat(own);
  const fallback = loadDictionary('en')[key];
  return typeof fallback === 'string' && fallback ? flat(fallback) : null;
}

function sentence(key, locale) {
  const value = lookup(key, locale);
  if (value === null) throw new Error(`no install sentence for ${key}`);
  return value;
}

function askLine(code, locale) {
  return `ASK:${code}:${sentence(`install.ask.${code}`, locale)}`;
}

function fixLine(code, command) {
  return `FIX:${code}:${command}`;
}

function nextLine(kind, detail) {
  return detail === undefined || detail === '' ? `NEXT:${kind}` : `NEXT:${kind}:${detail}`;
}

function main(argv) {
  const args = argv.slice();
  let locale = null;
  const li = args.indexOf('--locale');
  if (li !== -1) {
    // A Windows culture name (zh-TW) or a shell value (ja_JP.UTF-8) is accepted as it comes.
    locale = normalizeLocale(args[li + 1]) || 'en';
    args.splice(li, 2);
  }
  const [verb, first, ...rest] = args;
  const resolved = () => locale || detectLocale();
  switch (verb) {
    case 'ask': return askLine(first, resolved());
    case 'say': return sentence(first, resolved());
    case 'next': return nextLine(first, rest.join(' '));
    case 'fix': return fixLine(first, rest.join(' '));
    default: throw new Error('usage: install-messages.cjs ask|say|next|fix ...');
  }
}

module.exports = { askLine, fixLine, nextLine, sentence, detectLocale, normalizeLocale, flat };

if (require.main === module) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
